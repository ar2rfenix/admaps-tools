// modules/adm-levels/scripts/tools/scene-folder-import.mjs
// ADMaps Tools — "Import scenes from folder".
//
// A button in the scene directory header, between "Create Scene" and "Create Folder". The GM picks a folder
// in Foundry's Data — the module walks it together with its subfolders, finds scene JSON exports and
// imports each one as a SEPARATE scene exactly the way it is done by hand: create an empty
// scene → "Import Data" (Scene#importFromJSON) with the file contents.
//
// ⚠️ The import goes specifically through Scene#importFromJSON, not create() from the file data: it is
// wrapped by the "Teleports on transfer" tool (teleport-fix.mjs) — it takes the anchor from the
// file and repairs the teleport destinations. Direct creation would bypass that repair.
//
// Core shows "Imported…" on every import — on a batch that is dozens of toasts. For the duration
// of the batch we suppress ONLY that message (key DOCUMENT.Imported); instead there is a single progress
// bar and a summary.

const MODULE_ID = "adm-levels";
const MAX_FOLDERS = 800;        // safety limit for the subfolder walk
const BROWSE_CONC = 6;          // parallel browse requests

const FP = () => foundry.applications?.apps?.FilePicker?.implementation
  ?? foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;

/** All .json files in the folder and its subfolders (paths as the server returns them — URL-encoded). */
async function _collectJson(root) {
  const picker = FP();
  const files = [];
  const seen = new Set();
  const queue = [root];
  let scanned = 0;
  let truncated = false;
  while (queue.length) {
    if (scanned >= MAX_FOLDERS) { truncated = true; break; }
    const batch = queue.splice(0, BROWSE_CONC).filter((d) => !seen.has(d));
    batch.forEach((d) => seen.add(d));
    scanned += batch.length;
    const results = await Promise.all(batch.map((d) =>
      picker.browse("data", d, { extensions: [".json"] }).catch(() => null)));
    for (const r of results) {
      if (!r) continue;
      for (const f of (r.files || [])) if (/\.json$/i.test(String(f))) files.push(String(f));
      for (const d of (r.dirs || [])) queue.push(String(d));
    }
  }
  files.sort((a, b) => a.localeCompare(b, game.i18n.lang));
  return { files, truncated };
}

let _lastWorldFolder = "";      // scene folder from the previous import (within the session)

/** World scene folders as a tree: [{id, name, depth}] in traversal order, alphabetical at each level. */
function _sceneFolderOptions() {
  const all = game.folders.filter((f) => f.type === "Scene");
  const byParent = new Map();
  for (const f of all) {
    const pid = f.folder?.id ?? null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(f);
  }
  const out = [];
  const walk = (pid, depth) => {
    const kids = (byParent.get(pid) ?? []).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    for (const f of kids) { out.push({ id: f.id, name: f.name, depth }); walk(f.id, depth + 1); }
  };
  walk(null, 0);
  // A folder with a lost parent would not be reached by the walk — show it at the top level.
  const seen = new Set(out.map((o) => o.id));
  for (const f of all) if (!seen.has(f.id)) out.push({ id: f.id, name: f.name, depth: 0 });
  return out;
}

/** Whether the contents look like a scene export. */
function _looksLikeScene(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const uuid = String(data._stats?.exportSource?.uuid ?? "");
  if (uuid.startsWith("Scene.")) return true;
  return ("grid" in data) && ("width" in data) && ("height" in data)
    && (Array.isArray(data.walls) || Array.isArray(data.tokens) || Array.isArray(data.tiles));
}

const _baseName = (path) => {
  let n = String(path).split("/").pop() || "";
  try { n = decodeURIComponent(n); } catch { /* already decoded */ }
  return n.replace(/\.json$/i, "");
};

async function _readJson(path) {
  const res = await fetch(foundry.utils.getRoute(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return { text, data: JSON.parse(text) };
}

/** Folder selection in Foundry's Data. null — cancelled. */
function _pickFolder() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const fp = new (FP())({
      type: "folder",
      callback: (path, picker) => {
        if (picker?.activeSource && picker.activeSource !== "data") {
          ui.notifications.warn(game.i18n.localize("ADM_LEVELS.sceneImport.onlyData"));
          return finish(null);
        }
        finish(String(path ?? ""));
      },
    });
    fp.addEventListener?.("close", () => finish(null), { once: true });
    fp.render(true);
  });
}

async function _run() {
  if (!game.user?.isGM) return;
  const folder = await _pickFolder();
  if (folder == null) return;
  if (!folder.replace(/\/+$/, "")) {                            // the Data root is every module and world
    ui.notifications.warn(game.i18n.localize("ADM_LEVELS.sceneImport.rootRefused"));
    return;
  }
  const shown = (() => { try { return decodeURIComponent(folder) || "Data"; } catch { return folder || "Data"; } })();

  // 1. Search: walk the folder and pick out scene JSON exports.
  const scan = ui.notifications.info(game.i18n.format("ADM_LEVELS.sceneImport.scanning", { folder: shown }), { progress: true });
  let found = [];
  let totalJson = 0;
  let truncated = false;
  try {
    const col = await _collectJson(folder);
    truncated = col.truncated;
    totalJson = col.files.length;
    for (let i = 0; i < col.files.length; i++) {
      const path = col.files[i];
      try {
        const { data } = await _readJson(path);
        if (_looksLikeScene(data)) found.push({ path, name: String(data.name || _baseName(path)) });
      } catch { /* not JSON / unreadable — not a scene */ }
      scan.update({ pct: col.files.length ? (i + 1) / col.files.length : 1 });
    }
  } finally {
    scan.update({ pct: 1 });
  }

  if (truncated) ui.notifications.warn(game.i18n.format("ADM_LEVELS.sceneImport.truncated", { n: MAX_FOLDERS }));
  if (!found.length) {
    ui.notifications.warn(game.i18n.format("ADM_LEVELS.sceneImport.none", { folder: shown, json: totalJson }));
    return;
  }

  // 2. Confirmation and choice of the world scene folder: the batch may be large.
  const esc = foundry.utils.escapeHTML;
  const list = found.slice(0, 12).map((f) => `<li>${esc(f.name)}</li>`).join("")
    + (found.length > 12 ? `<li>… ${game.i18n.format("ADM_LEVELS.sceneImport.more", { n: found.length - 12 })}</li>` : "");
  const folders = _sceneFolderOptions();
  if (_lastWorldFolder && !folders.some((o) => o.id === _lastWorldFolder)) _lastWorldFolder = "";
  const options = [`<option value="">${esc(game.i18n.localize("ADM_LEVELS.sceneImport.rootFolder"))}</option>`]
    .concat(folders.map((o) => `<option value="${o.id}"${o.id === _lastWorldFolder ? " selected" : ""}>${"  ".repeat(o.depth)}${esc(o.name)}</option>`))
    .join("");
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("ADM_LEVELS.sceneImport.title"), icon: "fa-solid fa-file-import" },
    position: { width: 440 },
    content: `<p>${esc(game.i18n.format("ADM_LEVELS.sceneImport.confirm", { folder: shown, n: found.length }))}</p>
              <ul style="margin:.4em 0 .6em 1.2em;max-height:14em;overflow:auto;">${list}</ul>
              <div class="form-group">
                <label>${esc(game.i18n.localize("ADM_LEVELS.sceneImport.worldFolder"))}</label>
                <div class="form-fields"><select name="folder">${options}</select></div>
              </div>`,
    buttons: [
      { action: "import", label: game.i18n.localize("ADM_LEVELS.sceneImport.importBtn"), icon: "fa-solid fa-file-import", default: true,
        callback: (_ev, button) => ({ folder: String(button.form.elements.folder?.value ?? "") }) },
      { action: "cancel", label: game.i18n.localize("Cancel"), icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  }).catch(() => null);
  if (!choice || typeof choice !== "object") return;          // "Cancel" or the close button
  const worldFolder = game.folders.get(choice.folder) ? choice.folder : null;
  _lastWorldFolder = worldFolder ?? "";

  // 3. Import one at a time, as by hand: empty scene → "Import Data".
  const notes = ui.notifications;
  const origInfo = notes.info;
  const ownInfo = Object.hasOwn(notes, "info");                // restore exactly as it was
  notes.info = function (message, ...rest) {
    if (message === "DOCUMENT.Imported") return null;          // core toast for every scene
    return origInfo.call(this, message, ...rest);
  };
  const bar = origInfo.call(notes, game.i18n.format("ADM_LEVELS.sceneImport.importing", { n: found.length }), { progress: true });
  let imported = 0;
  const failed = [];
  try {
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      let scene = null;
      try {
        const { text } = await _readJson(f.path);             // do not keep the text in memory for the whole batch
        // The folder is set on creation: `folder` is in preserveOnImport, the import will not overwrite it.
        // ⚠️ `active: false` explicitly. In a world with no active scene the core activates the first scene created
        // without an `active` key (Scene._preCreateOperation): the canvas starts drawing that EMPTY scene, and
        // importFromJSON lands on it a moment later, in the middle of the draw. The first scene of the batch came out
        // black — no background, no walls. By hand there are seconds between the two steps, so the draw finishes first.
        // `active` is in preserveOnImport, the import keeps it false.
        scene = await Scene.implementation.create({ name: f.name, folder: worldFolder, active: false });
        if (!scene) throw new Error("scene not created");
        await scene.importFromJSON(text);
        imported++;
      } catch (e) {
        console.warn(`[ADM:Tools] sceneFolderImport: ${f.path}`, e);
        failed.push(f.name);
        try { await scene?.delete(); } catch { /* could not delete the empty one — no big deal */ }
      }
      bar.update({ pct: (i + 1) / found.length, message: game.i18n.format("ADM_LEVELS.sceneImport.progress", { i: i + 1, n: found.length, name: f.name }) });
    }
  } finally {
    if (ownInfo) notes.info = origInfo; else delete notes.info;
    bar.update({ pct: 1 });
  }

  if (failed.length) {
    ui.notifications.warn(game.i18n.format("ADM_LEVELS.sceneImport.doneFailed", { ok: imported, fail: failed.length, names: failed.slice(0, 5).join(", ") }));
  } else {
    ui.notifications.info(game.i18n.format("ADM_LEVELS.sceneImport.done", { n: imported }));
  }
}

function _injectButton(app, element, isEnabled) {
  if (!isEnabled() || !game.user?.isGM) return;
  const root = element instanceof HTMLElement ? element : app?.element;
  const actions = root?.querySelector?.(".header-actions");
  if (!actions || actions.querySelector("[data-adm-scene-import]")) return;
  const create = actions.querySelector('[data-action="createEntry"]');
  if (!create) return;                                          // no permission to create scenes
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.admSceneImport = "1";
  btn.className = "adm-scene-import";
  btn.dataset.tooltip = game.i18n.localize("ADM_LEVELS.sceneImport.button");
  btn.setAttribute("aria-label", btn.dataset.tooltip);
  btn.style.cssText = "flex:0 0 auto;min-width:2.4em;padding:0 .7em;";
  btn.innerHTML = '<i class="fa-solid fa-file-import" inert></i>';
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    _run().catch((e) => {
      console.error("[ADM:Tools] sceneFolderImport", e);
      ui.notifications.error(game.i18n.localize("ADM_LEVELS.sceneImport.error"));
    });
  });
  create.after(btn);
}

export const TOOL = {
  id: "sceneFolderImport",
  name: "ADM_LEVELS.settings.sceneFolderImport.name",
  hint: "ADM_LEVELS.settings.sceneFolderImport.hint",

  onReady({ isEnabled }) {
    Hooks.on("renderSceneDirectory", (app, element) => {
      try { _injectButton(app, element, isEnabled); } catch (e) { console.warn("[ADM:Tools] sceneFolderImport: button injection failed", e); }
    });
    // The scene directory is already rendered before ready — add the button right away.
    try { if (ui.scenes?.rendered) _injectButton(ui.scenes, ui.scenes.element, isEnabled); } catch { /* noop */ }
  },
};
