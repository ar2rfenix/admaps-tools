// Admaps Scene Switch
// A scene variation = an image/video file. A JSON (scene export) with the same name may
// sit next to the file: if it exists, the whole environment is swapped (background, walls,
// tiles, ambient sounds/lights), keeping tokens and everything the GM added themselves; if
// there is no JSON next to it, ONLY the background is changed.
// A variation's scene JSON may carry its own variation list — those are offered in the menu
// under their parent (nested variations, see _expandNested).
//
// «Keep what was added»: everything the module loads is marked with the flag
// flags["admaps-scene-switch"].managed=true. On swap we delete the marked docs and load
// the new ones (marking them too). For the INITIAL (bootstrap) detection of the base content
// we use the sidecar JSON of the ORIGINAL file (the background that was loaded originally).
// A doc the GM added by hand becomes part of a variation once it is exported into that variation's
// JSON: a doc whose _id the target JSON lists is swapped too (see _applyEnvironmentSwap).

const MOD = "admaps-scene-switch";

// ⚠️ getFlag/setFlag/unsetFlag with the namespace of a REMOVED module throw "scope not valid or not active".
// We access the flags DIRECTLY (data under the old namespace is intact; same behavior, minus the scope validation).
const _flagGet = (doc, ns, key) => foundry.utils.getProperty(doc?.flags ?? {}, `${ns}.${key}`);
const _flagSet = (doc, ns, key, val) => doc.update({ [`flags.${ns}.${key}`]: val });
const _flagDel = (doc, ns, key) => doc.update({ [`flags.${ns}.-=${key}`]: null });

const I18N = "ADMAPS_SCENE_SWITCH";

// Localization: _t("Notify.GMOnly") or _t("Notify.Switched", {scene, label}).
function _t(key, data) {
  const full = `${I18N}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/* ─────────────────────────── Swap scope ─────────────────────────── */

// Base scalar scene fields (background / foreground / background color).
const SCALAR_BASE = ["background", "foreground", "foregroundElevation", "backgroundColor"];
// Dimensions/grid (tier "dims" and above).
const SCALAR_DIMS = ["width", "height", "padding", "grid", "initial"];
// Environment/lighting + «Ambience» (tier "full").
// playlist / playlistSound / weather — fields of the scene's last tab (playlist,
// track, weather). environment/fog/tokenVision — top-level in v13 (darkness/globalLight
// live inside environment in v13 — kept as harmless no-ops for compatibility).
const SCALAR_FULL = ["environment", "darkness", "globalLight", "fog", "tokenVision", "playlist", "playlistSound", "weather"];

// Embedded collections: base (always) and extra (tier "full").
const EMBEDDED_BASE = [
  { key: "walls",  embed: "Wall" },
  { key: "tiles",  embed: "Tile" },
  { key: "sounds", embed: "AmbientSound" },
  { key: "lights", embed: "AmbientLight" },
];
const EMBEDDED_FULL = [
  { key: "drawings",  embed: "Drawing" },
  { key: "notes",     embed: "Note" },
  { key: "templates", embed: "MeasuredTemplate" },
  { key: "regions",   embed: "Region" },
];

function _scope() {
  try { return game.settings.get("adm-levels", "sceneSwitch.swapScope") || "base"; } catch { return "base"; }
}
function _scalarKeys() {
  const s = _scope();
  let keys = [...SCALAR_BASE];
  if (s === "dims" || s === "full") keys = keys.concat(SCALAR_DIMS);
  if (s === "full") keys = keys.concat(SCALAR_FULL);
  return keys;
}
function _embeddedDefs() {
  return _scope() === "full" ? EMBEDDED_BASE.concat(EMBEDDED_FULL) : EMBEDDED_BASE;
}
const ALL_EMBEDDED = EMBEDDED_BASE.concat(EMBEDDED_FULL);
const ALL_SCALAR = [...new Set([...SCALAR_BASE, ...SCALAR_DIMS, ...SCALAR_FULL])];

/* ─────────────────────────── Config storage ─────────────────────────── */
// flags[MOD].config = { originalFile, originalName, variations: [{id, name, file}] }
//   originalFile — path of the background the scene had originally (captured once).
//   originalName — user-defined name of the original (optional; otherwise «Original»).
//   file — path to an image/video OR to a .json scene dump. For an image the JSON is looked up
//          at the same path with .json; for .json the background/environment are read from the file itself.

function _getConfig(scene) {
  const f = _flagGet(scene, MOD, "config") ?? {};
  return {
    originalFile: typeof f.originalFile === "string" ? f.originalFile : "",
    originalName: typeof f.originalName === "string" ? f.originalName : "",
    variations: Array.isArray(f.variations) ? f.variations : [],
  };
}
async function _setConfig(scene, cfg) {
  const variations = Array.isArray(cfg.variations) ? cfg.variations : [];
  // No variations at all → the scene needs neither the flag nor the «original» snapshot.
  // Don't litter the scene: remove config (and current) if they were there.
  if (variations.length === 0) {
    const hasCfg = _flagGet(scene, MOD, "config") !== undefined;
    const hasCur = _flagGet(scene, MOD, "current") !== undefined;
    if (hasCfg || hasCur) {
      try { await scene.update({ [`flags.${MOD}.-=config`]: null, [`flags.${MOD}.-=current`]: null }); }
      catch { /* ignore */ }
    }
    return;
  }
  await _flagSet(scene, MOD, "config", {
    originalFile: typeof cfg.originalFile === "string" ? cfg.originalFile : "",
    originalName: typeof cfg.originalName === "string" ? cfg.originalName : "",
    variations,
  });
}

// Keep only the needed keys in the scene dump (background + embedded collections).
function _trimSceneData(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const k of ALL_SCALAR) if (k in obj) out[k] = obj[k];
  for (const e of ALL_EMBEDDED) if (Array.isArray(obj[e.key])) out[e.key] = obj[e.key];
  if (typeof obj.name === "string") out.name = obj.name;
  // Levels: background/weather elevation (flags.levels.*) — paired with the top-level foregroundElevation,
  // but these are NESTED flags. Capture them explicitly, otherwise the swap loses them (bug: the background stayed at 0
  // when switching to a variation with backgroundElevation = -15).
  const lv = obj.flags?.levels;
  if (lv && typeof lv === "object") {
    const keep = {};
    if ("backgroundElevation" in lv) keep.backgroundElevation = lv.backgroundElevation;
    if ("weatherElevation" in lv) keep.weatherElevation = lv.weatherElevation;
    if (Object.keys(keep).length) out.flags = { levels: keep };
  }
  return out;
}

/* ─────────────────────────── Files: sidecar JSON, name ─────────────────────────── */

const VIDEO_EXT = new Set(["webm", "mp4", "m4v", "ogv", "mov"]);

function _stripQuery(s) {
  const q = String(s ?? "").indexOf("?");
  return q >= 0 ? String(s).slice(0, q) : String(s ?? "");
}
function _isVideo(file) {
  const base = _stripQuery(file).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXT.has(base.slice(dot + 1));
}
// A .json variation = a «scene dump»: background/environment are read from the file itself.
function _isJson(file) {
  return /\.json$/i.test(_stripQuery(String(file ?? "")).toLowerCase());
}
// Decode URL-escaped path characters for display/storage (%5B→[, %20→space).
function _decodePath(p) {
  const s = String(p ?? "");
  try { return decodeURIComponent(s); } catch { return s; }
}
// File name without folder and extension (for the variant name hint).
function _basename(file) {
  const base = _stripQuery(file);
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  let name = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  try { name = decodeURIComponent(name); } catch { /* ignore */ }
  return name;
}
// Path to the sidecar JSON: same path, extension → .json.
function _sidecarJsonPath(file) {
  const base = _stripQuery(file);
  const dot = base.lastIndexOf(".");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return (dot > slash ? base.slice(0, dot) : base) + ".json";
}
// Does it look like scene data (guards against an accidentally parsed 404 page).
function _looksLikeScene(d) {
  return !!d && typeof d === "object" &&
    ("background" in d || "walls" in d || "width" in d || "grid" in d);
}
// Load scene JSON data FROM THE GIVEN path (trying several encodings).
// Returns the scene data object or null (no file / doesn't look like a scene).
async function _loadJsonAt(path) {
  if (!path) return null;
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  push(path);
  try { push(encodeURI(path)); } catch { /* ignore */ }
  try { push(encodeURI(decodeURIComponent(path))); } catch { /* ignore */ }
  try { push(decodeURIComponent(path)); } catch { /* ignore */ }
  for (const url of cands) {
    try {
      const data = await foundry.utils.fetchJsonWithTimeout(url, {}, { timeoutMs: 20000 });
      if (_looksLikeScene(data)) return data;
    } catch { /* try the next encoding variant */ }
  }
  return null;
}
// Sidecar JSON of an image/video file (same path, extension → .json).
async function _loadSidecar(file) {
  if (!file) return null;
  return _loadJsonAt(_sidecarJsonPath(file));
}

// Existence of an image/video file (HEAD via foundry.utils.srcExists) with
// several path encodings tried (spaces/Cyrillic) and a cache. A positive result is cached
// for a long time, a negative one for a short TTL (so a fixed file gets picked up).
const _existsCache = new Map(); // path -> { ok, ts }
const _EXISTS_TTL = 10000;
async function _fileExists(file) {
  const path = _stripQuery(String(file ?? ""));
  if (!path) return false;
  const hit = _existsCache.get(path);
  if (hit && (hit.ok || (Date.now() - hit.ts) < _EXISTS_TTL)) return hit.ok;
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  push(path);
  try { push(encodeURI(path)); } catch { /* ignore */ }
  try { push(encodeURI(decodeURIComponent(path))); } catch { /* ignore */ }
  try { push(decodeURIComponent(path)); } catch { /* ignore */ }
  let ok = false;
  for (const url of cands) {
    try { if (await foundry.utils.srcExists(url)) { ok = true; break; } } catch { /* next one */ }
  }
  _existsCache.set(path, { ok, ts: Date.now() });
  return ok;
}

/* ─────────────────────────── Nested variations ─────────────────────────── */
// A variation's scene JSON (the .json itself, or the sidecar of an image/video) is an export of a
// scene that may have ITS OWN variation list (flags[MOD].config.variations): «Forest River» with
// «Forest River Night». Those are offered in the menu right under their parent, so the original
// scene reaches them too. Up to NESTED_DEPTH levels; a file already listed is not repeated.

const NESTED_DEPTH = 3;
const _NESTED_TTL = 120000;          // scene JSONs can be large — re-read at most every 2 minutes
const _nestedCache = new Map(); // normalized json path -> { list: [{name, file}], ts }
const _normPath = (p) => _decodePath(_stripQuery(String(p ?? ""))).replace(/\\/g, "/").trim().toLowerCase();

/** The variation list stored in the scene JSON of `file` ([] — no JSON / no list). */
async function _nestedOf(file) {
  const jsonPath = _isJson(file) ? file : _sidecarJsonPath(file);
  const key = _normPath(jsonPath);
  const hit = _nestedCache.get(key);
  if (hit && (Date.now() - hit.ts) < _NESTED_TTL) return hit.list;
  let list = [];
  try {
    const raw = await _loadJsonAt(jsonPath);
    const vars = raw?.flags?.[MOD]?.config?.variations;
    if (Array.isArray(vars)) {
      list = vars
        .filter((v) => v && typeof v.file === "string" && v.file.trim())
        .map((v) => ({ name: typeof v.name === "string" ? v.name.trim() : "", file: _decodePath(v.file.trim()) }));
    }
  } catch { /* unreadable — no nested variations */ }
  _nestedCache.set(key, { list, ts: Date.now() });
  return list;
}

/** Nested variations of `file`, depth-first (a child is followed by its own children).
 *  `seen` — normalized paths already in the menu (shared, so nothing is listed twice). */
async function _expandNested(file, seen, depth = 1) {
  if (depth > NESTED_DEPTH) return [];
  // The JSON that lists these children = their parent's environment (used when a child has no JSON of its own).
  const parentJson = _isJson(file) ? file : _sidecarJsonPath(file);
  const kids = [];
  for (const k of await _nestedOf(file)) {
    const n = _normPath(k.file);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    kids.push({ ...k, depth, key: `nested:${n}`, parentJson });
  }
  const ok = await Promise.all(kids.map((k) => _fileExists(k.file)));
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    if (!ok[i]) continue;                         // broken path — hidden, like top-level ones
    out.push(kids[i]);
    out.push(...await _expandNested(kids[i].file, seen, depth + 1));
  }
  return out;
}

/* ─────────────────────────── Diff by value (bootstrap) ─────────────────────────── */

function _stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj) ?? "null";
  if (Array.isArray(obj)) return "[" + obj.map(_stableStringify).join(",") + "]";
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + _stableStringify(obj[k])).join(",") + "}";
}
function _docKey(o) {
  const c = foundry.utils.deepClone(o ?? {});
  delete c._id;
  delete c.flags;
  return _stableStringify(c);
}
// EXACT-copy key: the whole doc except _id and OUR flag. Foreign flags stay in — walls of different
// floors share every field and differ by flags["wall-height"] only, they are not copies of each other.
function _twinKey(o) {
  const c = foundry.utils.deepClone(o ?? {});
  delete c._id;
  if (c.flags && typeof c.flags === "object") {
    delete c.flags[MOD];
    if (!Object.keys(c.flags).length) delete c.flags;
  }
  return _stableStringify(c);
}

/* ─────────────────────────── Swap ─────────────────────────── */

// Guard against concurrent/double switches of the same scene.
const _switching = new Set();

// Bulk programmatic creation of embedded docs fires the create<Embed> hook BEFORE the
// canvas placeable is created (document.object is still null) — third-party modules (walledtemplates
// createWallHook → document.object.edge) crash on that. During creation we empty
// the array of those hooks and put them back afterwards: the canvas updates via the lifecycle, and
// a per-object refresh is redundant during a full swap.
function _suspendCreateHooks(embed) {
  try {
    const arr = Hooks.events?.[`create${embed}`];
    if (!Array.isArray(arr) || !arr.length) return null;
    return { arr, saved: arr.splice(0, arr.length) };
  } catch (e) { console.warn("[admaps-scene-switch] suspend hooks failed", e); return null; }
}
function _restoreCreateHooks(state) {
  try { if (state?.arr && Array.isArray(state.saved)) state.arr.push(...state.saved); }
  catch (e) { console.warn("[admaps-scene-switch] restore hooks failed", e); }
}

// Resilient deletion: when embedded docs change quickly on the active scene, the client
// collection may still show a document that no longer exists on the server. The server rejects
// the WHOLE batch because of one such id. Drop the missing id and retry with the rest.
async function _safeDeleteEmbedded(scene, embed, ids) {
  let pending = Array.from(new Set((ids ?? []).filter(Boolean)));
  let guard = 0;
  while (pending.length && guard++ < 25) {
    try {
      await scene.deleteEmbeddedDocuments(embed, pending);
      return;
    } catch (err) {
      const msg = String(err?.message ?? err ?? "");
      const m = msg.match(/"([^"]{12,24})"\s*does not exist/i);
      if (m) {
        const bad = m[1];
        const before = pending.length;
        pending = pending.filter(id => id !== bad);
        if (pending.length < before) {
          console.warn(`[admaps-scene-switch] ${embed}: skipped id ${bad} missing on the server`);
          continue;
        }
      }
      throw err;
    }
  }
}

// During the swap, selectively mute the server's «X does not exist!» notifications (the id is
// already deleted on the server; resilient deletion skips them). Our own console.warn stays.
function _installSwapNoiseFilter() {
  const notif = ui?.notifications;
  if (!notif) return null;
  const drop = (m) => /does not exist/i.test(String(m ?? ""));
  const ownError = Object.hasOwn(notif, "error");
  const ownWarn = Object.hasOwn(notif, "warn");
  const protoError = notif.error?.bind(notif);
  const protoWarn = notif.warn?.bind(notif);
  notif.error = (m, ...a) => (drop(m) ? undefined : protoError?.(m, ...a));
  notif.warn  = (m, ...a) => (drop(m) ? undefined : protoWarn?.(m, ...a));
  return { notif, ownError, ownWarn, protoError, protoWarn };
}
function _removeSwapNoiseFilter(s) {
  if (!s?.notif) return;
  try {
    if (s.ownError) s.notif.error = s.protoError; else delete s.notif.error;
    if (s.ownWarn)  s.notif.warn  = s.protoWarn;  else delete s.notif.warn;
  } catch (e) { console.warn("[admaps-scene-switch] restore notifications failed", e); }
}

// Foreign flags of a doc — all scopes EXCEPT our MOD (carried across the swap; the variation JSON doesn't have them).
function _foreignFlags(flags) {
  if (!flags || typeof flags !== "object") return null;
  const out = {};
  for (const k of Object.keys(flags)) if (k !== MOD) out[k] = foundry.utils.deepClone(flags[k]);
  return Object.keys(out).length ? out : null;
}
// MATCHING key old↔new doc: geometry without id/flags and without runtime-volatile fields.
// ds (door open/closed), hidden/alpha/sort/locked (tile) change during play and would diverge from
// the variation's pristine data → by _docKey (which includes them) a live doc would not match the variation.
// + move/sight/sound/light: adm-levels in «Tile binding» mode (wall follows the tile) toggles them at runtime
// (NORMAL↔NONE) — excluded so that a wall's identity = coordinates c + door type, stable across the swap.
const _VOLATILE_KEYS = new Set(["_id", "flags", "ds", "hidden", "alpha", "sort", "locked", "move", "sight", "sound", "light"]);
function _matchKey(o) {
  const c = {};
  for (const k of Object.keys(o ?? {})) if (!_VOLATILE_KEYS.has(k)) c[k] = o[k];
  return _stableStringify(c);
}
// Deep remap of id references inside flags: a string value equal to an old id from the map → the new id.
// ids are unique 16-char randomIDs, a false match is impossible; UUID strings are left alone (not an exact equality).
function _remapIds(value, idRemap) {
  if (typeof value === "string") return idRemap.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v => _remapIds(v, idRemap));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _remapIds(value[k], idRemap);
    return out;
  }
  return value;
}

// Full environment swap from scene data (sidecar JSON), preserving managed/GM AND foreign flags
// (adm-levels bindings etc.): the swap recreates docs with new ids, so foreign flags are taken off before
// deletion and given back to the new docs by geometry match, retargeting id references old→new.
async function _applyEnvironmentSwap(scene, cfg, target) {
  // Base content of the original for the bootstrap (first swap, when there is no managed yet) —
  // lazily, only if needed.
  let _origResolved;
  const getOrigData = async () => {
    if (_origResolved === undefined) {
      _origResolved = cfg.originalFile ? _trimSceneData(await _loadSidecar(cfg.originalFile)) : null;
    }
    return _origResolved;
  };

  const defs = _embeddedDefs();
  const foreignByEmbed = {};    // embed → Map(matchKey → foreign flags) taken off the old docs
  const createdByEmbed = {};    // embed → array of created documents (for phase 2)
  const oldIdToKey = new Map(); // oldId → matchKey (across ALL types)
  const keyToNewId = new Map(); // matchKey → newId (across ALL types)
  const seenOldKeys = new Set();
  const ambiguousKeys = new Set(); // geom key seen >1 time (old OR new) — don't remap/don't restore (risk of binding to a wrong doc)

  // PHASE 1: take off foreign flags, delete the old, create the new from the variation.
  for (const { key, embed } of defs) {
    try {
      const coll = scene[key];
      const current = Array.from(coll ?? []);

      let delIds = current.filter(d => _flagGet(d, MOD, "managed")).map(d => d.id);
      if (!delIds.length) {
        const orig = await getOrigData();
        if (orig && Array.isArray(orig[key])) {
          const origIds  = new Set(orig[key].map(d => d?._id).filter(Boolean));
          const origKeys = new Set(orig[key].map(_docKey));
          delIds = current.filter(d => {
            if (d.id && origIds.has(d.id)) return true;
            try { return origKeys.has(_docKey(d.toObject())); } catch { return false; }
          }).map(d => d.id);
        }
      }
      // A variation JSON is a scene export, and an export also carries what the GM added by hand (not
      // managed). Such a doc stayed in the scene AND was created again from the JSON — one more copy per
      // swap, and the next export baked the copies in. A doc whose _id is listed in the target JSON belongs
      // to that variation: it is swapped like the managed ones and comes back managed. The GM's docs the
      // JSON does not know (other ids) stay as before.
      const src = Array.isArray(target[key]) ? target[key] : [];
      const targetIds = new Set(src.map(d => d?._id).filter(Boolean));
      if (targetIds.size) {
        const queued = new Set(delIds);
        for (const d of current) if (d.id && targetIds.has(d.id) && !queued.has(d.id)) delIds.push(d.id);
      }
      delIds = delIds.filter(id => coll?.get?.(id));

      // Take foreign flags off the docs being deleted (key = geometry) + remember oldId→key for the id remap.
      const fmap = new Map();
      const delSet = new Set(delIds);
      for (const d of current) {
        if (!delSet.has(d.id)) continue;
        try {
          const obj = d.toObject();
          const mk = _matchKey(obj);
          if (seenOldKeys.has(mk)) ambiguousKeys.add(mk); else seenOldKeys.add(mk);
          oldIdToKey.set(d.id, mk);
          const ff = _foreignFlags(obj.flags);
          if (ff) fmap.set(mk, ff);
        } catch (_) {}
      }
      foreignByEmbed[embed] = fmap;

      if (delIds.length) await _safeDeleteEmbedded(scene, embed, delIds);

      // Exact copies of one doc inside the JSON (left there by the duplication above) are created once.
      // Docs come back under their OWN ids from the JSON (keepId): every doc of the scene with such an id was deleted
      // above, and teleport destinations, tile bindings and other id references of the variation stay valid. With new
      // ids a switch broke all ten teleports of the ship — their destinations pointed at deleted regions (24.09.2026).
      // An id still taken (a deletion that did not go through) — a new id, as before.
      const seenTwins = new Set();
      const keptIds = new Set();
      const toCreate = [];
      for (const d of src) {
        const tk = _twinKey(d);
        if (seenTwins.has(tk)) continue;
        seenTwins.add(tk);
        const o = foundry.utils.deepClone(d);
        const keep = (typeof o._id === "string") && !keptIds.has(o._id) && !coll?.get?.(o._id);
        if (keep) keptIds.add(o._id); else delete o._id;
        o.flags = o.flags ?? {};
        o.flags[MOD] = Object.assign({}, o.flags[MOD], { managed: true });
        toCreate.push(o);
      }
      if (toCreate.length) {
        const susp = _suspendCreateHooks(embed);
        let created;
        try {
          try { created = await scene.createEmbeddedDocuments(embed, toCreate, { keepId: true }); }
          catch (e) {
            console.warn(`[admaps-scene-switch] ${embed}: creating with the JSON ids failed, new ids instead`, e);
            for (const o of toCreate) delete o._id;
            created = await scene.createEmbeddedDocuments(embed, toCreate);
          }
        }
        finally { _restoreCreateHooks(susp); }
        created = Array.isArray(created) ? created : (created ? [created] : []);
        createdByEmbed[embed] = created;
        for (const nd of created) {
          try {
            const mk = _matchKey(nd.toObject());
            if (keyToNewId.has(mk)) ambiguousKeys.add(mk);
            keyToNewId.set(mk, nd.id);
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error(`[admaps-scene-switch] swap failed for ${embed}`, e);
      ui.notifications.warn(_t("Notify.PartialFail", { embed, error: e?.message ?? e }));
    }
  }

  // Map old id → new id (by shared geometry, cross-type: a wall flag references a tile).
  const idRemap = new Map();
  for (const [oldId, mk] of oldIdToKey) {
    if (ambiguousKeys.has(mk)) continue; // ambiguous geometry — don't risk linking to a wrong doc
    const newId = keyToNewId.get(mk);
    if (newId && newId !== oldId) idRemap.set(oldId, newId);
  }

  // PHASE 2: give foreign flags back to the new docs (by geometry match) with the id-reference remap.
  // updateEmbedded with {flags} MERGES (our flags[MOD].managed isn't wiped). The update hooks are
  // NOT muted here — let adm-levels (updateWall bindChanged) re-sync the tile visibility right away.
  for (const { embed } of defs) {
    const fmap = foreignByEmbed[embed];
    const created = createdByEmbed[embed];
    if (!fmap?.size || !created?.length) continue;
    const updates = [];
    for (const nd of created) {
      let mk;
      try { mk = _matchKey(nd.toObject()); } catch (_) { continue; }
      if (ambiguousKeys.has(mk)) continue; // ambiguous geometry — don't restore (risk of wrong flags)
      const ff = fmap.get(mk);
      if (ff) updates.push({ _id: nd.id, flags: _remapIds(ff, idRemap) });
    }
    if (updates.length) {
      try { await scene.updateEmbeddedDocuments(embed, updates); }
      catch (e) { console.warn(`[admaps-scene-switch] restore foreign flags failed for ${embed}`, e); }
    }
  }

  // Scalar fields (background etc.).
  const upd = {};
  for (const k of _scalarKeys()) if (k in target) upd[k] = target[k];
  // Levels: background elevation (paired with foregroundElevation) — a nested flag, written explicitly.
  // Target has a value → set it; NONE → explicit reset to 0 (otherwise the elevation would remain
  // from the previous variation). weatherElevation is touched only if it is set in the target.
  const lv = target.flags?.levels;
  upd["flags.levels.backgroundElevation"] = (lv && "backgroundElevation" in lv) ? lv.backgroundElevation : 0;
  if (lv && "weatherElevation" in lv) upd["flags.levels.weatherElevation"] = lv.weatherElevation;
  if (Object.keys(upd).length) await scene.update(upd);
}

const SOUNDMIX_MOD = "admaps-soundmix";
// Carry the mix binding from the target JSON (flags.admaps-soundmix.preset) over to the scene.
// soundmix picks up the change of this flag on the active scene and switches playback.
// No admaps-soundmix block in the JSON → the mix is left alone (e.g. a background-only variation).
async function _applySceneMix(scene, raw) {
  const smx = raw?.flags?.[SOUNDMIX_MOD];
  if (!smx || typeof smx !== "object") return;
  const next = typeof smx.preset === "string" ? smx.preset : "";
  const cur = _flagGet(scene, SOUNDMIX_MOD, "preset") ?? "";
  if (cur === next) return; // same mix — no need to touch it
  try { await scene.update({ [`flags.${SOUNDMIX_MOD}.preset`]: next }); }
  catch (e) { console.warn("[admaps-scene-switch] soundmix preset apply failed", e); }
}

/**
 * Keep the floor picked in the Levels layer tool through the swap. A swap changes the background, core redraws the
 * canvas, and Levels closes its floor view on canvasInit (levels/scripts/ui.js: close(true) → rangeEnabled = false)
 * while the picked level stays in `range` — the floor buttons still showed it, the view was «Levels off»: every door
 * of every floor (24.09.2026). The floor is put back once the redraw is done (canvasReady), the same steps as the
 * floor buttons take; `arm()` (after the swap) covers a swap without a redraw: a floor still intact is left alone.
 */
function _keepLevelsFloor(scene) {
  const ui0 = globalThis.CONFIG?.Levels?.UI;
  const floor = (ui0?.rangeEnabled && Array.isArray(ui0.range) && ui0.range.length >= 2) ? [...ui0.range] : null;
  if (!floor) return null;
  let done = false;
  const restore = () => {
    done = true;
    const ui = globalThis.CONFIG?.Levels?.UI;
    if (!ui || canvas?.scene?.id !== scene.id) return;
    if (ui.rangeEnabled && String(ui.range?.[0]) === String(floor[0]) && String(ui.range?.[1]) === String(floor[1])) return;
    ui.range = floor;
    ui.rangeEnabled = true;
    try { ui.activateForeground?.(); } catch { /* ignore */ }
    try { ui.computeLevelsVisibility(); } catch (e) { console.warn("[admaps-scene-switch] restore Levels floor", e); }
    Hooks.callAll("levelsUiChangeLevel");
  };
  const hookId = Hooks.once("canvasReady", restore);
  return {
    arm() {
      setTimeout(() => {
        if (done || !canvas?.ready) return; // done already, or a redraw is still under way — canvasReady will do it
        Hooks.off("canvasReady", hookId);
        restore();
      }, 3000);
    },
  };
}

/** `direct` = {file, label, parentJson} — a NESTED variation (from a variation's own scene JSON, not
 *  in this scene's list); `variationId` is then its menu key (for the "current" mark). parentJson —
 *  the JSON that lists it: its environment is used when the variation has no JSON of its own. */
export async function admapsSwitchVariation(scene, variationId, direct = null) {
  if (!scene) return;
  if (!game.user.isGM) { ui.notifications.warn(_t("Notify.GMOnly")); return; }
  if (_switching.has(scene.id)) { ui.notifications.info(_t("Notify.InProgress")); return; }

  const cfg = _getConfig(scene);
  let file, label;
  if (variationId === "__original__") { file = cfg.originalFile; label = cfg.originalName || _t("Menu.Original"); }
  else if (direct?.file) { file = direct.file; label = direct.label || _basename(direct.file) || _t("Menu.Unnamed"); }
  else {
    const v = cfg.variations.find(x => x.id === variationId);
    if (!v) { ui.notifications.error(_t("Notify.VariationNotFound")); return; }
    file = v.file;
    label = v.name || _t("Menu.Unnamed");
  }
  if (!file) { ui.notifications.error(_t("Notify.NoFile")); return; }
  // The variation file is missing (broken path) — don't set a broken background, report it.
  if (!(await _fileExists(file))) { ui.notifications.warn(_t("Notify.FileMissing", { label })); return; }

  _switching.add(scene.id);
  const _noise = _installSwapNoiseFilter();
  const _floor = _keepLevelsFloor(scene);
  try {
    // A .json variation — the environment is read from the file itself (background inside it).
    // Image/video — look for a JSON next to it (sidecar); if none, change only the background.
    let raw = _isJson(file) ? await _loadJsonAt(file) : await _loadSidecar(file);
    // A NESTED image/video without a JSON of its own: the environment of ITS PARENT (the JSON that
    // lists it — «Forest River Night» takes «Forest River»), with this variation's picture as the background.
    let ownBackground = null;
    if (!raw && !_isJson(file) && direct?.parentJson) {
      raw = await _loadJsonAt(direct.parentJson);
      if (raw) ownBackground = file;
    }
    const target = _trimSceneData(raw);
    if (target && ownBackground) target.background = { ...(target.background ?? {}), src: ownBackground };

    if (target) {
      // ⚠️ With a level picked in the Levels layer tool, Levels' preCreate hooks give EVERY created tile, wall,
      // light, sound, note, drawing and region that level's range (levels/scripts/ui.js: tile elevation = level
      // bottom + rangeTop, wall-height bottom/top, …) — meant for drawing by hand. The swap recreates the whole
      // environment, so the entire scene was rewritten to the picked level: all 18 tiles of the ship at 15..30,
      // the hold's floor included, and walls without their floor heights — «Levels is broken for good after a
      // switch» (24.09.2026). Levels' own «tokens only» switch makes those hooks step aside; it is put back after.
      const lvUi = globalThis.CONFIG?.Levels?.UI;
      const prevTokensOnly = lvUi?.tokensOnly;
      if (lvUi) lvUi.tokensOnly = true;
      try { await _applyEnvironmentSwap(scene, cfg, target); }
      finally { if (lvUi) lvUi.tokensOnly = prevTokensOnly; }
    } else if (_isJson(file)) {
      // A .json is given but it can't be read / doesn't look like a scene — leave the background alone.
      ui.notifications.error(_t("Notify.BadJson", { label }));
      return;
    } else {
      // No JSON next to it — change only the background (other background fields are kept).
      await scene.update({ "background.src": file });
    }

    // Scene mix (soundmix): if the target JSON has a mix binding, carry it over to the scene.
    // soundmix switches playback itself (it reacts to a change of flags.admaps-soundmix.preset
    // on the active scene). No module / no mix data in the JSON — harmless, left alone.
    await _applySceneMix(scene, raw);

    await _flagSet(scene, MOD, "current", variationId);
    ui.notifications.info(_t(target ? "Notify.Switched" : "Notify.SwitchedBgOnly", { scene: scene.name, label }));
  } catch (err) {
    console.error("[admaps-scene-switch] swap failed", err);
    ui.notifications.error(_t("Notify.SwapError", { error: err?.message ?? err }));
  } finally {
    _removeSwapNoiseFilter(_noise);
    _switching.delete(scene.id);
    _floor?.arm();
  }
}

/* ─────────────────────────── «Variations» submenu ─────────────────────────── */

let _hideTimer = null;

function _removeSubmenu() {
  document.getElementById("asw-submenu")?.remove();
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}
function _scheduleHide() {
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(_removeSubmenu, 180);
}
function _cancelHide() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}

async function _buildSubmenu(scene) {
  const cfg = _getConfig(scene);
  const menu = document.createElement("nav");
  menu.id = "asw-submenu";
  menu.className = "asw-submenu";

  const list = document.createElement("ul");
  menu.append(list);

  const cur = _flagGet(scene, MOD, "current") ?? null;

  const addItem = (labelHtml, onClick, { active = false, kind = "", depth = 0 } = {}) => {
    const li = document.createElement("li");
    li.className = "asw-submenu-item" + (active ? " asw-active" : "") + (kind ? ` asw-${kind}` : "");
    if (depth > 0) li.style.paddingLeft = `${10 + depth * 16}px`;
    li.innerHTML = labelHtml;
    li.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      _removeSubmenu();
      ui.context?.close?.();
      onClick();
    });
    list.append(li);
    return li;
  };

  // Check that the files exist and HIDE variations whose file is broken/missing
  // until the user fixes it (image/video; the sidecar JSON is not
  // required). Checks run in parallel, with a cache.
  const origOk = cfg.originalFile ? await _fileExists(cfg.originalFile) : false;
  const withFile = cfg.variations.filter(v => v.file);
  const checks = await Promise.all(withFile.map(v => _fileExists(v.file)));
  const validVars = withFile.filter((_v, i) => checks[i]);

  if (origOk) {
    addItem(
      `<i class="fa-solid fa-rotate-left fa-fw"></i><span>${foundry.utils.escapeHTML(cfg.originalName || _t("Menu.Original"))}</span>`,
      () => admapsSwitchVariation(scene, "__original__"),
      { active: cur === "__original__" }
    );
  }

  // Nested variations: read every variation's scene JSON (in parallel, cached), then list each
  // parent's own variations right under it. The original and the top-level files are not repeated.
  const seen = new Set([cfg.originalFile, ...validVars.map((v) => v.file)].map(_normPath).filter(Boolean));
  await Promise.all(validVars.map((v) => _nestedOf(v.file)));
  const nestedByVar = new Map();
  for (const v of validVars) nestedByVar.set(v.id, await _expandNested(v.file, seen));

  const iconOf = (file) => (_isJson(file) ? "fa-file-code" : _isVideo(file) ? "fa-film" : "fa-image");
  if (validVars.length) {
    for (const v of validVars) {
      addItem(
        `<i class="fa-solid ${iconOf(v.file)} fa-fw"></i><span>${foundry.utils.escapeHTML(v.name || _basename(v.file) || _t("Menu.Unnamed"))}</span>`,
        () => admapsSwitchVariation(scene, v.id),
        { active: cur === v.id }
      );
      for (const k of nestedByVar.get(v.id) ?? []) {
        const label = k.name || _basename(k.file) || _t("Menu.Unnamed");
        addItem(
          `<i class="fa-solid ${iconOf(k.file)} fa-fw"></i><span>${foundry.utils.escapeHTML(label)}</span>`,
          () => admapsSwitchVariation(scene, k.key, { file: k.file, label, parentJson: k.parentJson }),
          { active: cur === k.key, kind: "nested", depth: k.depth }
        );
      }
    }
  }

  if (!origOk && !validVars.length) {
    const li = document.createElement("li");
    li.className = "asw-submenu-empty";
    // Distinguish «nothing configured» from «everything configured is unavailable (broken files)».
    const hadAny = !!cfg.originalFile || cfg.variations.some(v => v.file);
    li.textContent = hadAny ? _t("Menu.FilesMissing") : _t("Menu.NoVariations");
    list.append(li);
  }

  menu.addEventListener("mouseenter", _cancelHide);
  menu.addEventListener("mouseleave", _scheduleHide);
  return menu;
}

let _submenuGen = 0;

async function _showSubmenu(anchorEl, sceneId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const gen = ++_submenuGen;
  _removeSubmenu();
  const menu = await _buildSubmenu(scene); // async: file existence check
  // While the check was running the hover may have changed/left: don't show a stale menu.
  if (gen !== _submenuGen) return;
  document.body.append(menu);

  const a = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 100;
  let left = a.right - 2;
  if (left + mw > window.innerWidth - 4) left = a.left - mw + 2;
  if (left < 4) left = 4;
  let top = a.top - 4;
  if (top + mh > window.innerHeight - 4) top = window.innerHeight - mh - 4;
  if (top < 4) top = 4;
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}

function _bindVariationsHover(entryEl, sceneId) {
  entryEl.addEventListener("mouseenter", () => { _cancelHide(); _showSubmenu(entryEl, sceneId); });
  entryEl.addEventListener("mouseleave", _scheduleHide);
}

/* ─────────────────────────── Config dialog (minimalist) ─────────────────────────── */

function _fileRowHTML(v = {}) {
  const id = v.id || foundry.utils.randomID();
  const name = foundry.utils.escapeHTML(v.name ?? "");
  const file = foundry.utils.escapeHTML(_decodePath(v.file ?? ""));
  const phName = foundry.utils.escapeHTML(_t("Dialog.NamePlaceholder"));
  const phFile = foundry.utils.escapeHTML(_t("Dialog.FilePlaceholder"));
  const ttPick = foundry.utils.escapeHTML(_t("Dialog.PickFile"));
  const ttDel = foundry.utils.escapeHTML(_t("Dialog.Delete"));
  const ttDrag = foundry.utils.escapeHTML(_t("Dialog.Drag"));
  return `
<div class="asw-var-row" data-var-id="${id}">
  <span class="asw-var-drag" data-action="asw-drag" draggable="true" title="${ttDrag}">⠿</span>
  <input type="text" class="asw-var-name" placeholder="${phName}" value="${name}" />
  <div class="asw-var-file">
    <input type="text" class="asw-var-path" placeholder="${phFile}" value="${file}" />
    <button type="button" class="asw-pick" data-action="asw-pick" title="${ttPick}"><i class="fa-solid fa-folder-open"></i></button>
  </div>
  <button type="button" class="asw-del" data-action="asw-del-var" title="${ttDel}"><i class="fa-solid fa-trash"></i></button>
</div>`;
}

function _configContentHTML(scene, origBg = "") {
  const cfg = _getConfig(scene);
  const origSrc = origBg || cfg.originalFile || "";
  const origFile = _decodePath(origSrc);
  const origNameVal = foundry.utils.escapeHTML(cfg.originalName ?? "");
  const origPh = foundry.utils.escapeHTML(_basename(origSrc) || _t("Menu.Original"));
  const origTitle = foundry.utils.escapeHTML(origFile);
  const rows = cfg.variations.map(_fileRowHTML).join("");
  const lblOrig = foundry.utils.escapeHTML(_t("Dialog.Original"));
  const ttSetOrig = foundry.utils.escapeHTML(_t("Dialog.SetOriginal"));
  const ttAdd = foundry.utils.escapeHTML(_t("Dialog.AddVariation"));
  return `
<div class="asw-config">
  <div class="asw-orig" title="${origTitle}" data-file="${foundry.utils.escapeHTML(origFile)}">
    <span>${lblOrig}</span>
    <input type="text" class="asw-orig-name" placeholder="${origPh}" value="${origNameVal}" />
    <button type="button" class="asw-pick" data-action="asw-pick-orig" title="${ttSetOrig}"><i class="fa-solid fa-folder-open"></i></button>
  </div>
  <div class="asw-vars">${rows}</div>
  <button type="button" class="asw-add" data-action="asw-add-var" title="${ttAdd}"><i class="fa-solid fa-plus"></i></button>
</div>`;
}

function _collectConfig(root, scene) {
  const variations = [];
  // Row order = current DOM order (accounts for drag-drop sorting).
  for (const row of root.querySelectorAll(".asw-var-row")) {
    const id = row.dataset.varId || foundry.utils.randomID();
    const name = String(row.querySelector(".asw-var-name")?.value ?? "").trim();
    const file = _decodePath(String(row.querySelector(".asw-var-path")?.value ?? "").trim());
    if (!name && !file) continue;
    variations.push({ id, name: name || _basename(file) || _t("Menu.Unnamed"), file });
  }
  const origFromDom = root.querySelector(".asw-orig")?.dataset?.file;
  const origName = String(root.querySelector(".asw-orig-name")?.value ?? "").trim();
  const cur = _getConfig(scene);
  return {
    originalFile: _decodePath((typeof origFromDom === "string" ? origFromDom : cur.originalFile) || ""),
    originalName: origName,
    variations,
  };
}
async function _saveFromDOM(root, scene) {
  try { await _setConfig(scene, _collectConfig(root, scene)); }
  catch (e) { console.error("[admaps-scene-switch] save config failed", e); }
}

/**
 * Start path for the file picker: the row's own path if it has one, otherwise the file the
 * variations sit next to — the scene's original background (config.originalFile) or, before
 * any variation exists, the current background. The picker opens that file's folder, so the
 * user lands where the scene's files live instead of the Data root.
 */
function _pickerStart(scene, currentVal) {
  const own = String(currentVal ?? "").trim();
  if (own) return own;
  const cfg = _getConfig(scene);
  return cfg.originalFile || scene?.background?.src || scene?._source?.background?.src || "";
}

function _pickFile(currentVal, onPick, type = "imagevideo") {
  try {
    const FP = foundry.applications?.apps?.FilePicker?.implementation
      ?? foundry.applications?.apps?.FilePicker
      ?? globalThis.FilePicker?.implementation
      ?? globalThis.FilePicker;
    if (!FP) { ui.notifications.error(_t("Notify.FilePickerUnavailable")); return; }
    new FP({
      type,
      current: currentVal || "",
      callback: (path) => { try { onPick(_decodePath(String(path ?? ""))); } catch (e) { console.error(e); } },
    }).render(true);
  } catch (e) {
    console.error("[admaps-scene-switch] FilePicker failed", e);
    ui.notifications.error(_t("Notify.FilePickerError"));
  }
}

function _wireConfigDialog(root, scene) {
  if (!root) return;

  // Button clicks.
  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "asw-add-var") {
      ev.preventDefault();
      // Open the file picker right away; the row is added after the pick (cancel — nothing).
      // Starts in the scene's folder (see _pickerStart).
      _pickFile(_pickerStart(scene, ""), (path) => {
        if (!path) return;
        const tmp = document.createElement("div");
        tmp.innerHTML = _fileRowHTML({ file: path, name: _basename(path) });
        const rowEl = tmp.firstElementChild;
        root.querySelector(".asw-vars")?.append(rowEl);
        _saveFromDOM(root, scene);
        rowEl.querySelector(".asw-var-name")?.focus();
      }, "any");
    }
    else if (action === "asw-del-var") {
      ev.preventDefault();
      btn.closest(".asw-var-row")?.remove();
      _saveFromDOM(root, scene);
    }
    else if (action === "asw-pick") {
      ev.preventDefault();
      const row = btn.closest(".asw-var-row");
      const pathInput = row?.querySelector(".asw-var-path");
      const nameInput = row?.querySelector(".asw-var-name");
      _pickFile(_pickerStart(scene, pathInput?.value), (path) => {
        if (pathInput) pathInput.value = path;
        if (nameInput && !nameInput.value.trim()) nameInput.value = _basename(path);
        _saveFromDOM(root, scene);
      }, "any");
    }
    else if (action === "asw-pick-orig") {
      ev.preventDefault();
      const wrap = root.querySelector(".asw-orig");
      _pickFile(_pickerStart(scene, wrap?.dataset?.file), (path) => {
        if (wrap) {
          wrap.dataset.file = path;
          wrap.title = path;
          // The original's name is user-defined (input); only the placeholder hint is updated.
          const nm = wrap.querySelector(".asw-orig-name");
          if (nm) nm.placeholder = _basename(path) || _t("Menu.Original");
        }
        _saveFromDOM(root, scene);
      });
    }
  });

  // Field changes (variant name / path / original name) — saved on change.
  root.addEventListener("change", (ev) => {
    if (ev.target.closest(".asw-var-name, .asw-var-path, .asw-orig-name")) _saveFromDOM(root, scene);
  });

  // ── Drag-drop sorting of variations (by the ⠿ handle) ──
  let _dragRow = null;
  const _rowAfter = (cont, y) => {
    const rows = [...cont.querySelectorAll(".asw-var-row:not(.asw-dragging)")];
    for (const r of rows) {
      const box = r.getBoundingClientRect();
      if (y < box.top + box.height / 2) return r;
    }
    return null;
  };
  root.addEventListener("dragstart", (ev) => {
    const handle = ev.target.closest?.(".asw-var-drag");
    if (!handle) return;
    _dragRow = handle.closest(".asw-var-row");
    if (!_dragRow) return;
    try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", _dragRow.dataset.varId || ""); } catch (_e) {}
    _dragRow.classList.add("asw-dragging");
  });
  root.addEventListener("dragover", (ev) => {
    if (!_dragRow) return;
    const cont = root.querySelector(".asw-vars");
    if (!cont) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch (_e) {}
    const after = _rowAfter(cont, ev.clientY);
    if (after == null) cont.appendChild(_dragRow);
    else if (after !== _dragRow) cont.insertBefore(_dragRow, after);
  });
  root.addEventListener("drop", (ev) => { if (_dragRow) ev.preventDefault(); });
  root.addEventListener("dragend", () => {
    if (!_dragRow) return;
    _dragRow.classList.remove("asw-dragging");
    _dragRow = null;
    _saveFromDOM(root, scene);
  });
}

async function _openConfigDialog(scene) {
  if (!game.user.isGM) { ui.notifications.warn(_t("Notify.GMOnlyShort")); return; }

  // The original background (what is on the scene right now) is kept ONLY in the dialog's memory.
  // Nothing is written to the flag until the first variation is added (see _setConfig):
  // otherwise an empty config/snapshot would settle on the scene just from opening the window.
  const cur = _getConfig(scene);
  const origBg = cur.originalFile || scene.background?.src || scene._source?.background?.src || "";

  const DialogV2 = foundry.applications.api.DialogV2;
  await DialogV2.wait({
    window: { title: _t("Dialog.Title", { scene: scene.name }), icon: "fa-solid fa-images" },
    position: { width: 760 },
    content: _configContentHTML(scene, origBg),
    buttons: [{ action: "close", label: _t("Dialog.Done"), icon: "fa-solid fa-check" }],
    render: (event, dialog) => {
      const root = dialog.element?.querySelector(".asw-config") ?? dialog.element;
      // The original (from memory) goes into the dataset for collection when a variation is added.
      const wrap = root?.querySelector?.(".asw-orig");
      if (wrap) wrap.dataset.file = _decodePath(origBg);
      _wireConfigDialog(root, scene);
    },
    rejectClose: false,
  });

  // On close — a final save (in case of unsaved edits).
  // (the render handlers already save on changes; this is a safety net.)
}

/* ─────────────────────────── ADMaps Tools sub-module descriptor ─────────────────────────── */

export const TOOL = {
  id: "sceneSwitch",
  name: "ADM_LEVELS.settings.sceneSwitch.name",
  hint: "ADM_LEVELS.settings.sceneSwitch.hint",
  replaces: ["admaps-scene-switch"],

  // The swapScope setting is registered in i18nInit (translations loaded → choices get localized).
  // Namespace moved to adm-levels, key sceneSwitch.swapScope (config:true — visible in settings).
  onInit() {
    Hooks.once("i18nInit", () => {
      game.settings.register("adm-levels", "sceneSwitch.swapScope", {
        name: _t("Settings.SwapScope.Name"),
        hint: _t("Settings.SwapScope.Hint"),
        scope: "world",
        config: true,
        type: String,
        choices: {
          base: _t("Settings.SwapScope.Base"),
          dims: _t("Settings.SwapScope.Dims"),
          full: _t("Settings.SwapScope.Full"),
        },
        default: "base",
      });
    });
  },

  onReady({ isEnabled }) {
    // «Variations» entry in the navbar scene context menu (only the open scene, GM).
    Hooks.on("getSceneContextOptions", (app, items) => {
      if (!isEnabled()) return;
      if (!game.user.isGM) return;
      const entry = {
        name: `${I18N}.Menu.Variations`, // ContextMenu localizes item.name itself
        icon: '<i class="fa-solid fa-images"></i>',
        condition: (li) => {
          const el = li?.dataset ? li : li?.[0];
          const sceneId = el?.dataset?.sceneId;
          if (!sceneId) return false;
          if (sceneId !== (canvas?.scene?.id ?? null)) return false;
          requestAnimationFrame(() => {
            const elem = entry.element;
            if (elem && !elem.dataset.aswBound) {
              elem.dataset.aswBound = "1";
              elem.classList.add("asw-context-entry");
              _bindVariationsHover(elem, sceneId);
            }
          });
          return true;
        },
        callback: (li) => {
          const el = li?.dataset ? li : li?.[0];
          const sceneId = el?.dataset?.sceneId;
          const scene = sceneId ? game.scenes.get(sceneId) : null;
          _removeSubmenu();
          if (scene) _openConfigDialog(scene);
        },
      };
      items.push(entry);
    });

    // Close the hover submenu on outside click / scroll.
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest("#asw-submenu") && !ev.target.closest(".asw-context-entry")) _removeSubmenu();
    }, { passive: true });
    window.addEventListener("scroll", _removeSubmenu, { passive: true, capture: true });

    // Public API: the ADMaps Tools container + global (macro compatibility).
    const api = { switch: admapsSwitchVariation, openConfig: _openConfigDialog };
    const mod = game.modules.get("adm-levels");
    if (mod) (mod.api ??= {}).sceneSwitch = api;
    globalThis.admapsSceneSwitch = api;
  },
};
