// scripts/tools/scene-export-name.mjs
// ADMaps Tools sub-module: «Scene export name» (named after the map file).
//
// By default Foundry names a scene export `fvtt-Scene-<name-slug>-<id>.json`.
// This sub-module names the file after the scene's BACKGROUND map (scene.background.src) —
// without folder and extension. Example: background `Stonehenge_%5Bocean%5D.webm` →
// file `Stonehenge_[ocean].json`. No background — the default name stays.
//
// How: we wrap Scene.prototype.exportToJSON. saveDataToFile in foundry.utils is
// read-only (cannot be replaced), so we replicate the export logic
// (toCompendium + exportSource) and save under OUR OWN file name. The JSON data and the
// scene name inside are left untouched. No background / any error → default export.

const MODULE_ID = "adm-levels";

// File name from the background map: strip folder/query, decode %XX, drop the extension.
function _fileNameFromScene(scene) {
  const src = scene?.background?.src;
  if (!src) return null;
  let base = String(src).split(/[?#]/)[0].split(/[\\/]/).pop() || "";
  try { base = decodeURIComponent(base); } catch (_e) { /* leave as is */ }
  base = base.replace(/\.[^.]+$/, "").trim();
  return base || null;
}

// Replicate the exportToJSON logic (toCompendium + exportSource) and save under our own
// file name. saveDataToFile is ONLY called (it cannot be reassigned — read-only).
//
// ⚠️ THE CORE MUST BE REPLICATED LITERALLY, including both lines below. This used to be
// «roughly like the core», and that silently broke teleports for everyone who imported our
// maps: in a foreign world the scene gets a NEW id while regions keep theirs, so in
// «Scene.<id>.Region.<id>» the first segment goes stale. That can only be fixed knowing
// the id of the ORIGINAL scene, and exactly one line puts it into the file — `uuid: this.uuid`.
// The previous version wrote the obsolete v12 form `flags.exportSource` WITHOUT uuid, and the
// core shim substituted null for it on load (foundry.mjs, «Migrate
// flags.exportSource»). Plus `clearSource` without an explicit false took its default
// true and wiped all three origin markers from `_stats`. Result: the file arrived without
// a single trace of where it came from, and teleport-fix could do nothing.
function _wrapExport(wrapped, args, isEnabled) {
  if (!isEnabled() || this?.documentName !== "Scene") return wrapped(...args);
  const name = _fileNameFromScene(this);
  if (!name) return wrapped(...args); // no background → default name
  try {
    // A copy, not the original object: clearSource is added below, and args belong to
    // the caller — an in-place edit would leak outside.
    const options = { ...(args?.[0] ?? {}) };
    options.clearSource ??= false; // like the core: origin markers MUST go into the file
    // deepClone → a plain object without getters: on the raw toCompendium result the
    // flags.exportSource property turned out getter-only (v12 shim) and threw on assignment.
    const data = foundry.utils.deepClone(this.toCompendium(null, options));
    data._stats ??= {};
    data._stats.exportSource = {
      worldId: game.world?.id ?? null,
      uuid: this.uuid,               // ← «Scene.<id>»: the anchor for fixing teleports
      coreVersion: game.version ?? null,
      systemId: game.system?.id ?? null,
      systemVersion: game.system?.version ?? null,
    };
    foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", `${name}.json`);
  } catch (e) {
    console.warn("[ADM:Tools] sceneExportName: custom export failed, falling back to core:", e);
    return wrapped(...args);
  }
}

export const TOOL = {
  id: "sceneExportName",
  name: "ADM_LEVELS.settings.sceneExportName.name",
  hint: "ADM_LEVELS.settings.sceneExportName.hint",

  onReady({ isEnabled }) {
    // libWrapper (if present) — a clean MIXED wrapper; otherwise a direct prototype patch.
    // The toggle is checked INSIDE the wrapper → switching takes effect without a reload.
    if (globalThis.libWrapper?.register) {
      try {
        libWrapper.register(MODULE_ID, "Scene.prototype.exportToJSON", function (wrapped, ...args) {
          return _wrapExport.call(this, wrapped, args, isEnabled);
        }, "MIXED");
        return;
      } catch (e) { console.warn("[ADM:Tools] sceneExportName libWrapper failed, using direct patch:", e); }
    }
    const proto = globalThis.Scene?.prototype;
    const orig = proto?.exportToJSON;
    if (typeof orig !== "function" || orig.__admExportName) return;
    const patched = function (...args) {
      return _wrapExport.call(this, orig.bind(this), args, isEnabled);
    };
    patched.__admExportName = true;
    proto.exportToJSON = patched;
  },
};
