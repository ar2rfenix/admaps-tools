// modules/adm-levels/scripts/tools/scene-quick-export.mjs
// ADMaps Tools — «Quick scene export».
//
// A scene context menu item right after «Export Data». After confirmation
// («Quick-export scene … into the scene files folder?») the scene JSON is saved straight
// into the folder holding its background image or video — with no Windows save dialog. A file with
// the same name is overwritten.
//
// How.
//  • Data and file name come from the STOCK export: we call scene.exportToJSON() and intercept
//    the download. That way the file gets exactly what «Export Data» produces (including the
//    origin marker for teleport repair and the name from the «Scene export name» tool), and there is
//    no need to duplicate core logic. For the duration of the call we replace URL.createObjectURL (grab the Blob) and the click
//    on saveDataToFile's invisible link (grab the name and do NOT let the browser download).
//  • Writing is done via the stock FilePicker.upload into Foundry data. No OS dialog, works in
//    any client, requires GM upload rights. Overwriting is allowed by the server: Foundry lists JSON
//    as a media type (MEDIA_MIME_TYPES), and uploading those over an existing file is permitted.

const MODULE_ID = "adm-levels";

const FP = () => foundry.applications?.apps?.FilePicker?.implementation
  ?? foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;

/** Scene background folder relative to Data: «_ADMaps/Nature/Ravine». External URL or no background — null. */
function _dirFromScene(scene) {
  const src = scene?.background?.src;
  if (!src) return null;
  let s = String(src).split(/[?#]/)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;          // http(s)/S3 — no local folder
  try { s = decodeURIComponent(s); } catch { /* already decoded */ }
  const parts = s.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();                                              // the file name itself
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

/** Run the stock scene export and return {blob, name} instead of downloading. */
async function _captureExport(scene) {
  let blob = null;
  let name = null;
  const origCreate = URL.createObjectURL;
  const anchor = HTMLAnchorElement.prototype;
  const ownDispatch = Object.hasOwn(anchor, "dispatchEvent");
  const prevDispatch = anchor.dispatchEvent;
  URL.createObjectURL = function (obj) {
    if (obj instanceof Blob) blob = obj;
    return origCreate.call(this, obj);
  };
  anchor.dispatchEvent = function (event) {
    if (event?.type === "click" && this.download && !this.isConnected) {
      name = this.download;
      return true;                                          // do not start the download
    }
    return prevDispatch.call(this, event);
  };
  try {
    const r = scene.exportToJSON();
    if (r && typeof r.then === "function") await r;         // someone's wrapper made the export async
  } finally {
    URL.createObjectURL = origCreate;
    if (ownDispatch) anchor.dispatchEvent = prevDispatch;
    else delete anchor.dispatchEvent;
  }
  if (!blob || !name) return null;
  // The folder marker is appended by the system for its own save dialog — it must not end up in the file name.
  name = String(name).replace(/^ADMDIR~[A-Za-z0-9_-]+~/, "");
  return { blob, name };
}

async function _fileExists(dir, name) {
  try {
    const r = await FP().browse("data", dir);
    const want = name.toLowerCase();
    return (r?.files || []).some((f) => {
      let n = String(f).split("/").pop() || "";
      try { n = decodeURIComponent(n); } catch { /* noop */ }
      return n.toLowerCase() === want;
    });
  } catch { return false; }
}

async function _quickExport(scene) {
  const i18n = game.i18n;
  const sceneName = scene.name ?? "";
  const dir = _dirFromScene(scene);
  if (!dir) { ui.notifications.warn(i18n.localize("ADM_LEVELS.quickExport.noFolder")); return; }

  const esc = foundry.utils.escapeHTML;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: i18n.localize("ADM_LEVELS.quickExport.title"), icon: "fa-solid fa-bolt" },
    content: `<p>${esc(i18n.format("ADM_LEVELS.quickExport.confirm", { name: sceneName }))}</p>`,
    rejectClose: false,
  }).catch(() => false);
  if (!ok) return;

  let cap = null;
  try { cap = await _captureExport(scene); }
  catch (e) { console.error("[ADM:Tools] sceneQuickExport: export failed", e); }
  if (!cap) { ui.notifications.error(i18n.format("ADM_LEVELS.quickExport.failed", { name: sceneName })); return; }

  try {
    const existed = await _fileExists(dir, cap.name);
    const file = new File([cap.blob], cap.name, { type: "application/json" });
    const res = await FP().upload("data", dir, file, {}, { notify: false });
    if (!res?.path) throw new Error("upload returned no path");
    let shown = res.path;
    try { shown = decodeURIComponent(res.path); } catch { /* noop */ }
    ui.notifications.info(i18n.format(existed ? "ADM_LEVELS.quickExport.overwritten" : "ADM_LEVELS.quickExport.saved",
      { name: sceneName, path: shown }));
  } catch (e) {
    console.error("[ADM:Tools] sceneQuickExport: write failed", e);
    ui.notifications.error(i18n.format("ADM_LEVELS.quickExport.failed", { name: sceneName }));
  }
}

export const TOOL = {
  id: "sceneQuickExport",
  name: "ADM_LEVELS.settings.sceneQuickExport.name",
  hint: "ADM_LEVELS.settings.sceneQuickExport.hint",

  onReady({ isEnabled }) {
    Hooks.on("getSceneContextOptions", (directory, entries) => {
      // The hook is also fired by scene compendiums — the entry there is not from the world, nothing to export.
      if (directory?.collection instanceof foundry.documents.collections.CompendiumCollection) return;
      const getScene = (li) => {
        const el = li?.closest?.("[data-entry-id]") ?? li?.closest?.("[data-scene-id]");
        return game.scenes.get(el?.dataset.entryId ?? el?.dataset.sceneId);
      };
      const item = {
        name: "ADM_LEVELS.quickExport.menu",
        icon: '<i class="fa-solid fa-bolt"></i>',
        condition: (li) => {
          if (!isEnabled() || !game.user?.isGM) return false;
          return !!_dirFromScene(getScene(li));
        },
        callback: (li) => {
          const scene = getScene(li);
          if (scene) _quickExport(scene).catch((e) => console.error("[ADM:Tools] sceneQuickExport", e));
        },
      };
      const at = entries.findIndex((e) => e?.name === "SIDEBAR.Export");
      if (at >= 0) entries.splice(at + 1, 0, item);        // right after «Export Data»
      else entries.push(item);
    });
  },
};
