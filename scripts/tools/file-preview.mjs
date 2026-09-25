// admaps-file-preview — Preview files on hover in File Picker
// Sounds: play on hover (loop), stop on leave
// Images: show thumbnail preview
// Videos (.webm): show video preview

const SOUND_EXT = new Set(["mp3", "ogg", "wav", "flac", "m4a", "webm"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"]);
const VIDEO_EXT = new Set(["webm", "mp4"]);

let _activeAudio = null;
let _previewEl = null;
let _indicatorEl = null;
let _hoveredFile = null;
let _hoverTimer = null;
const HOVER_DELAY = 500; // ms

function _getExt(filename) {
  const m = String(filename ?? "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

// Seconds → "M:SS". NaN/∞ (metadata not loaded yet) → "—".
function _fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function _getFullPath(li) {
  // Try data-path attribute first
  const path = li.dataset?.path;
  if (path) return path;

  // Build from file picker context
  const picker = li.closest(".filepicker-body")?.closest(".app");
  const input = picker?.querySelector('input[name="target"]') ?? picker?.querySelector(".current-dir input");
  const dir = input?.value ?? "";
  const name = li.querySelector(".entry-name")?.textContent?.trim() ?? "";
  if (!name) return "";
  return dir ? `${dir}/${name}` : name;
}

function _isSound(ext, fullPath) {
  // .webm could be video or audio — check context or treat as video by default
  if (ext === "webm") {
    // In a sounds directory, treat as audio
    return /sounds?\//i.test(fullPath) || /music\//i.test(fullPath) || /audio\//i.test(fullPath) || /sfx\//i.test(fullPath);
  }
  return SOUND_EXT.has(ext) && ext !== "webm";
}

function _isVideo(ext, fullPath) {
  if (ext === "webm" && !_isSound(ext, fullPath)) return true;
  if (ext === "mp4") return true;
  return false;
}

function _isImage(ext) {
  return IMAGE_EXT.has(ext);
}

function _stopAudio() {
  if (_activeAudio) {
    _activeAudio.pause();
    _activeAudio.src = "";
    _activeAudio = null;
  }
  if (_indicatorEl) {
    _indicatorEl.remove();
    _indicatorEl = null;
  }
}

function _removePreview() {
  if (_previewEl) {
    // Stop video if playing
    const video = _previewEl.querySelector("video");
    if (video) { video.pause(); video.src = ""; }
    _previewEl.remove();
    _previewEl = null;
  }
}

function _cleanup() {
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  _stopAudio();
  _removePreview();
  _hoveredFile = null;
}

function _playSound(fullPath) {
  _stopAudio();
  const audio = new Audio(fullPath);
  audio.loop = true;
  audio.volume = 0.5;
  audio.play().catch(() => {});
  _activeAudio = audio;

  // Show indicator (current time / duration, updated live)
  const el = document.createElement("div");
  el.className = "admfp-sound-indicator";
  el.innerHTML = `<i class="fas fa-volume-up"></i> <span class="admfp-time-txt">0:00 / —</span>`;
  document.body.appendChild(el);
  _indicatorEl = el;

  const _timeEl = el.querySelector(".admfp-time-txt");
  const _update = () => {
    if (_timeEl) _timeEl.textContent = `${_fmtTime(audio.currentTime)} / ${_fmtTime(audio.duration)}`;
  };
  audio.addEventListener("loadedmetadata", _update);
  audio.addEventListener("timeupdate", _update);
}

function _showImage(fullPath) {
  _removePreview();
  const el = document.createElement("div");
  el.className = "admfp-preview";
  el.innerHTML = `<img src="${foundry.utils.escapeHTML(fullPath)}" />`;
  document.body.appendChild(el);
  _previewEl = el;
}

function _showVideo(fullPath) {
  _removePreview();
  const el = document.createElement("div");
  el.className = "admfp-preview";
  el.innerHTML = `<video src="${foundry.utils.escapeHTML(fullPath)}" autoplay loop muted></video><div class="admfp-time">0:00 / —</div>`;
  document.body.appendChild(el);
  _previewEl = el;

  // Time: current / duration, updated live.
  const video = el.querySelector("video");
  const timeEl = el.querySelector(".admfp-time");
  if (video && timeEl) {
    const _update = () => { timeEl.textContent = `${_fmtTime(video.currentTime)} / ${_fmtTime(video.duration)}`; };
    video.addEventListener("loadedmetadata", _update);
    video.addEventListener("timeupdate", _update);
  }
}

function _onMouseEnter(ev) {
  const li = ev.target.closest("li.file");
  if (!li) return;

  const fullPath = _getFullPath(li);
  if (!fullPath || fullPath === _hoveredFile) return;

  _cleanup();
  _hoveredFile = fullPath;

  _hoverTimer = setTimeout(() => {
    _hoverTimer = null;
    if (_hoveredFile !== fullPath) return; // cursor moved away during delay
    const ext = _getExt(fullPath);

    if (_isSound(ext, fullPath)) {
      _playSound(fullPath);
    } else if (_isVideo(ext, fullPath)) {
      _showVideo(fullPath);
    } else if (_isImage(ext)) {
      _showImage(fullPath);
    }
  }, HOVER_DELAY);
}

function _onMouseLeave(ev) {
  const li = ev.target.closest("li.file");
  if (!li) return;
  // Check if we're moving to a child element (not actually leaving)
  const related = ev.relatedTarget;
  if (related && li.contains(related)) return;
  _cleanup();
}

// ────────────────────────────────────────────────────────────────────────
// Recursive subfolder search in FilePicker.
// The stock search (input[name=filter]) only filters the current folder. Here we
// walk all subfolders via FilePicker.browse (BFS, limited concurrency),
// build an index (cached per folder+source) and inject subfolder matches
// as a separate <ul.admfp-deep-list> into section[data-files]. Each result is
// <li class="file" data-action="pickFile" data-path data-name> → the stock click
// (#onPickFile), the stock SearchFilter (by data-name) and the hover preview work
// out of the box. The index is built lazily on the first non-empty query.
// ────────────────────────────────────────────────────────────────────────

// Index cache: { key: "source::folder", index: {files,truncated}|null, promise|null }
let _deepCache = { key: null, index: null, promise: null };

// Normalization for comparison: case, diacritics and separators.
// ⚠️ Diacritics are stripped THE SAME WAY as the core's stock SearchFilter (NFD + strip
// U+0300..U+036F). For Cyrillic this folds yo→ye and short-i→i: without it our subfolder
// search was STRICTER than the stock one, and a name with yo was not found for a query with ye.
// Separators "_", "-" and whitespace are collapsed into a single space: the same name
// is written in libraries both as "Ambient_Forest_Night" and "Ambient Forest Night" — before,
// the substring did not match, and long names "could not be found".
// ⚠️ We are intentionally LOOSER than the stock filter. It runs over our rows
// afterwards and hides some of them, but every input re-renders the list from scratch, so
// the final state is ours.
function _norm(str) {
  return String(str ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_ \t-]+/g, " ")
    .trim();
}

// Index cache key.
// ⚠️ Extensions MUST be part of the key: the index is built for the extension list
// of a SPECIFIC picker. Without them, an index built for a scene background (images+video)
// was reused in the audio picker for the same folder — and images and videos
// showed up in the sound search.
function _deepKey(app, source, root) {
  const e = Array.isArray(app?.extensions) ? app.extensions : [];
  return `${source}::${root}::${e.join(",")}`;
}

// Check the extension against the picker's list (a list like [".ogg",".mp3",...], lowercase+dot).
function _extOk(path, exts) {
  if (!exts || !exts.length) return true;
  const clean = String(path).split("?")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return exts.includes(clean.slice(dot).toLowerCase());
}

// Path relative to the current folder (for display + data-name), decoded.
function _deepRel(path, root) {
  let rel = String(path);
  if (root && (rel === root || rel.startsWith(root + "/"))) rel = rel.slice(root.length).replace(/^\/+/, "");
  try { rel = decodeURIComponent(rel); } catch { /* leave as is */ }
  return rel || String(path);
}

// Icon/preview for a result — mirrors the FilePicker._prepareContext logic.
function _deepFileImg(path) {
  const p = String(path).toLowerCase().split("?")[0];
  if (/\.webm$/.test(p) && /(sound|music|audio|sfx)s?\//.test(p)) return "icons/svg/sound.svg";
  if (/\.(webm|mp4|m4v|ogv|mov)$/.test(p)) return "icons/svg/video.svg";
  if (/\.(mp3|ogg|wav|flac|m4a|opus|aac)$/.test(p)) return "icons/svg/sound.svg";
  if (/\.(png|jpe?g|gif|svg|webp|avif|bmp)$/.test(p)) return path;
  return "icons/svg/book.svg";
}

function _deepHintLi(text) {
  const li = document.createElement("li");
  li.className = "admfp-deep-hint";
  li.textContent = text;
  return li;
}

// List display mode class (as in core body.hbs): list→details, thumbs/tiles/images as is.
function _modeClass(app) {
  const m = String(app?.displayMode ?? "list");
  return (m === "thumbs" || m === "tiles" || m === "images") ? m : "details";
}

// Find-or-create our <ul> inside section[data-files].
function _deepEnsureUl(app) {
  const section = app?.element?.querySelector?.("section[data-files]");
  if (!section) return null;
  let ul = section.querySelector("ul.admfp-deep-list");
  if (!ul) {
    ul = document.createElement("ul");
    ul.style.display = "none";
    section.appendChild(ul);
  }
  // Class — matches the picker's CURRENT displayMode (list/thumbs/tiles/images), so our list
  // looks like the stock one (thumbnails in image mode). Refreshed on every call —
  // on a mode change the picker renders parts:["body"] → the list is recreated with the new class.
  ul.className = `directory files-list ${_modeClass(app)} admfp-deep-list`;
  return ul;
}

// Recursive subfolder walk → flat list of file paths.
async function _deepBuildIndex(app, source, root) {
  const FP = app.constructor; // FilePicker (static browse)
  const exts = Array.isArray(app.extensions) ? app.extensions : null;
  const files = [];
  const seen = new Set();
  const queue = [root || ""];
  let scanned = 0;
  let truncated = false;
  const MAX_FOLDERS = 600, MAX_FILES = 8000, CONC = 8;
  while (queue.length && scanned < MAX_FOLDERS) {
    const batch = [];
    while (batch.length < CONC && queue.length) {
      const d = queue.shift();
      if (seen.has(d)) continue;
      seen.add(d);
      batch.push(d);
    }
    if (!batch.length) break;
    scanned += batch.length;
    const results = await Promise.all(batch.map((d) =>
      FP.browse(source, d, { extensions: exts ?? undefined, wildcard: false }).catch(() => null)
    ));
    for (const r of results) {
      if (!r) continue;
      for (const f of (r.files || [])) {
        const path = typeof f === "string" ? f : (f?.url ?? f?.path);
        if (!path || (exts && !_extOk(path, exts))) continue;
        files.push(path);
        if (files.length >= MAX_FILES) { truncated = true; break; }
      }
      if (files.length >= MAX_FILES) break;
      for (const d of (r.dirs || [])) {
        const dp = typeof d === "string" ? d : d?.path;
        if (dp && !seen.has(dp)) queue.push(dp);
      }
    }
    if (files.length >= MAX_FILES) break;
  }
  if (queue.length && scanned >= MAX_FOLDERS) truncated = true;
  return { files, truncated };
}

// Clear/hide our list.
function _deepClear(app) {
  const ul = app?.element?.querySelector?.("section[data-files] ul.admfp-deep-list");
  if (ul) { ul.replaceChildren(); ul.style.display = "none"; }
}

// Run a query: (build the index if needed) → filter → render.
async function _deepRun(app, query) {
  const source = app.activeSource ?? "data";
  const root = String(app.result?.target ?? "").replace(/\/+$/, "");
  const key = _deepKey(app, source, root);
  if (_deepCache.key !== key) _deepCache = { key, index: null, promise: null };

  let ul = _deepEnsureUl(app);
  if (!ul) return;

  if (!_deepCache.index) {
    ul.replaceChildren(_deepHintLi(game.i18n.localize("ADM_LEVELS.filePreview.indexing")));
    ul.style.display = "";
    if (!_deepCache.promise) {
      _deepCache.promise = _deepBuildIndex(app, source, root)
        .then((idx) => { if (_deepCache.key === key) _deepCache.index = idx; return idx; })
        .catch(() => { const idx = { files: [], truncated: false }; if (_deepCache.key === key) _deepCache.index = idx; return idx; });
    }
    await _deepCache.promise;
    // The query changed, the folder changed or the picker re-rendered during the walk — bail out.
    const live = app.element?.querySelector?.('input[name="filter"]');
    const nowRoot = String(app.result?.target ?? "").replace(/\/+$/, "");
    if (!live || live.value.trim() !== query || nowRoot !== root) return;
    ul = _deepEnsureUl(app);
    if (!ul) return;
  }

  const idx = _deepCache.index || { files: [], truncated: false };
  const ql = _norm(query);
  const CAP = 600;
  // Re-check extensions ON OUTPUT, not only when building the index: a safeguard
  // in case the index came from a picker of a different type (the cache key already
  // separates these) or the source ignored extensions while browsing.
  const exts = Array.isArray(app.extensions) ? app.extensions : null;
  const matches = [];
  for (const p of idx.files) {
    if (exts && !_extOk(p, exts)) continue;
    const rel = _deepRel(p, root);
    if (_norm(rel).includes(ql)) { matches.push({ path: p, rel }); if (matches.length >= CAP) break; }
  }

  const mode = String(app?.displayMode ?? "list");
  const frag = document.createDocumentFragment();
  for (const m of matches) {
    const li = document.createElement("li");
    // core's thumbs mode is flexrow (icon+name in a row); the others are just "file".
    li.className = mode === "thumbs" ? "file flexrow admfp-deep" : "file admfp-deep";
    li.setAttribute("data-file", "");
    li.setAttribute("data-action", "pickFile");
    li.dataset.path = m.path;
    li.dataset.name = m.rel;
    li.title = m.rel;
    const img = document.createElement("img");
    img.src = _deepFileImg(m.path);
    img.loading = "lazy";
    if (mode === "thumbs") { img.width = 48; img.height = 48; }
    if (mode === "tiles" || mode === "images") img.alt = m.rel;
    li.appendChild(img);
    // Caption — as in core body.hbs: list = icon+name; thumbs/images = span.filename; tiles = no caption.
    if (mode === "list") {
      const ic = document.createElement("i");
      ic.className = "fa-solid fa-file fa-fw";
      ic.setAttribute("inert", "");
      li.appendChild(ic);
      li.appendChild(document.createTextNode(" " + m.rel));
    } else if (mode === "thumbs" || mode === "images") {
      const span = document.createElement("span");
      span.className = "filename";
      span.textContent = m.rel;
      li.appendChild(span);
    }
    frag.appendChild(li);
  }
  ul.replaceChildren(frag);
  if (matches.length && (idx.truncated || matches.length >= CAP)) {
    ul.appendChild(_deepHintLi(game.i18n.format("ADM_LEVELS.filePreview.shown", { n: matches.length, more: idx.truncated ? "+" : "" })));
  }
  ul.style.display = matches.length ? "" : "none";
}

// Initialization on every picker render (full and partial).
function _deepInit(app) {
  try { if (game.user?.can?.("FILES_BROWSE") === false) return; } catch { /* ignore */ }
  const el = app?.element;
  const input = el?.querySelector?.('input[name="filter"]');
  const section = el?.querySelector?.("section[data-files]");
  if (!input || !section) return;

  // Folder/source key — reset the cache when the folder changes.
  const source = app.activeSource ?? "data";
  const root = String(app.result?.target ?? el.querySelector('input[name="target"]')?.value ?? "").replace(/\/+$/, "");
  const key = _deepKey(app, source, root);
  if (_deepCache.key !== key) _deepCache = { key, index: null, promise: null };

  _deepEnsureUl(app);

  // Subscribe to the search field — once per specific input (after a re-render the input is new).
  if (!input.dataset.admfpDeepWired) {
    input.dataset.admfpDeepWired = "1";
    let timer = null;
    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (timer) { clearTimeout(timer); timer = null; }
      if (!q) { _deepClear(app); return; }       // empty — hide right away
      timer = setTimeout(() => { _deepRun(app, q); }, 160);
    });
  }

  // If there is already an active query after a re-render — run it again.
  const q0 = input.value.trim();
  if (q0) _deepRun(app, q0);
}

/* ───────── Poster frame instead of the icon for videos ─────────
   Foundry draws .webm/.mp4 in the file picker with a generic icon — you can't tell
   which video it is. We replace it with a <video> with a time anchor: the browser renders
   a frame and stops, playing nothing.
   ⚠️ Only modes with previews (thumbs/tiles/images): in list mode the icon slot
   is 16px, a frame couldn't be made out there anyway.
   ⚠️ Loaded LAZILY via IntersectionObserver: otherwise a folder of two hundred videos
   would fire two hundred metadata requests at once. */

const VIDEO_THUMB_EXT = new Set(["webm", "mp4", "m4v", "ogv"]);
const POSTER_TIME = 0.1;   // not 0: at frame zero Chromium often leaves it black
let _thumbIO = null;
let _thumbMO = null;

function _thumbObserver() {
  if (_thumbIO) return _thumbIO;
  try {
    _thumbIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        _thumbIO.unobserve(e.target);
        _loadPosterFrame(e.target);
      }
    }, { rootMargin: "200px" });
  } catch (_e) { _thumbIO = null; }
  return _thumbIO;
}

function _loadPosterFrame(video) {
  const src = video.dataset?.admSrc;
  if (!src || video.src) return;
  video.src = `${src}#t=${POSTER_TIME}`;
}

function _applyVideoThumbs(rootEl, app) {
  const mode = String(app?.displayMode ?? "list");
  if (mode !== "thumbs" && mode !== "tiles" && mode !== "images") return;

  for (const li of rootEl.querySelectorAll("li[data-path], li[data-file]")) {
    if (li.dataset.admVideoThumb) continue;
    const path = _getFullPath(li);
    if (!VIDEO_THUMB_EXT.has(_getExt(path))) continue;

    // What we replace: the preview image (there is none anyway) or the file icon.
    const slot = li.querySelector("img") ?? li.querySelector("i.fa-solid, i.fas, i[class*='fa-']");
    if (!slot) continue;
    li.dataset.admVideoThumb = "1";

    const v = document.createElement("video");
    v.className = slot.className || "";
    v.dataset.admSrc = path;
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.tabIndex = -1;
    // inert — so a click on the frame reaches the li and file selection works.
    v.style.pointerEvents = "none";
    if (slot.tagName === "IMG") {
      if (slot.width) v.width = slot.width;
      if (slot.height) v.height = slot.height;
    } else {
      v.style.width = "48px";
      v.style.height = "48px";
      v.style.objectFit = "cover";
    }
    // The frame failed to render (codec/corrupt file) — restore the original icon.
    v.addEventListener("error", () => { try { v.replaceWith(slot); } catch (_e) {} }, { once: true });

    slot.replaceWith(v);
    const io = _thumbObserver();
    if (io) io.observe(v); else _loadPosterFrame(v);
  }
}

/** The picker re-renders the list on its own (navigation, mode change, our deep search) —
 *  we catch that with an observer rather than a single pass on render. */
function _watchVideoThumbs(rootEl, app) {
  _applyVideoThumbs(rootEl, app);
  try {
    _thumbMO?.disconnect?.();
    let queued = false;
    _thumbMO = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; _applyVideoThumbs(rootEl, app); });
    });
    _thumbMO.observe(rootEl, { childList: true, subtree: true });
  } catch (_e) {}
}

function _cleanupVideoThumbs() {
  try { _thumbMO?.disconnect?.(); } catch (_e) {}
  try { _thumbIO?.disconnect?.(); } catch (_e) {}
  _thumbMO = null;
  _thumbIO = null;
}

/* ───────── ADMaps Tools sub-module descriptor ───────── */

export const TOOL = {
  id: "filePreview",
  name: "ADM_LEVELS.settings.filePreview.name",
  hint: "ADM_LEVELS.settings.filePreview.hint",
  replaces: ["admaps-file-preview"],

  onReady({ isEnabled }) {
    // File Picker (v1): hover preview.
    Hooks.on("renderApplication", (app, html) => {
      if (!isEnabled()) return;
      if (!(app instanceof FilePicker)) return;
      const el = html instanceof jQuery ? html[0] : html;
      if (!el) return;
      el.addEventListener("mouseenter", _onMouseEnter, true);
      el.addEventListener("mouseleave", _onMouseLeave, true);
      _watchVideoThumbs(el, app);
    });

    // File Picker (ApplicationV2, v13): hover preview + recursive subfolder search.
    Hooks.on("renderApplicationV2", (app, html) => {
      if (!isEnabled()) return;
      const _fpClass = foundry.applications?.api?.FilePicker;
      const _name = app?.constructor?.name ?? "";
      const isFilePicker = _name === "FilePicker"
        || _name.includes("FilePicker")
        || (_fpClass && app instanceof _fpClass)
        || app?.element?.classList?.contains("filepicker");
      if (!isFilePicker) return;
      const el = html instanceof jQuery ? html[0] : (html ?? app.element);
      if (!el) return;
      el.addEventListener("mouseenter", _onMouseEnter, true);
      el.addEventListener("mouseleave", _onMouseLeave, true);
      _watchVideoThumbs(el, app);
      _deepInit(app);
    });

    // Cleanup when the picker closes.
    Hooks.on("closeApplication", (app) => {
      if (app instanceof FilePicker) { _cleanup(); _cleanupVideoThumbs(); }
    });
    Hooks.on("closeApplicationV2", (app) => {
      const _name = app?.constructor?.name ?? "";
      if (_name === "FilePicker" || _name.includes("FilePicker")) {
        _cleanup();
        _cleanupVideoThumbs();
        _deepCache = { key: null, index: null, promise: null }; // reset the index (files may have changed)
      }
    });
  },
};
