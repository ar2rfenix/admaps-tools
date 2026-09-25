// scripts/tools/active-adventure.mjs
// "Active adventure": a destination folder for scene copies.
//
// Why. Template scenes must be kept clean — no tokens, fog or other play-session
// junk dragged into them. Mark a folder as the adventure, then right-click any
// scene in the navbar to make A COPY of it in that folder and switch to the copy.
// The original stays untouched, and the adventure holds only what was actually needed.
//
// Two menu entries:
//   Right-click a folder in the Scenes list → "Active adventure" (mark the folder).
//   Right-click a scene in the navbar       → "Copy and view" (shown only when
//                                  a folder is marked).
//
// ⚠️ The copy is NOT activated: the switch uses scene.view() — the canvas changes only
// for the GM. Activating would yank all players over, and the scene usually still needs work.

const MODULE_ID = "adm-levels";
const SETTING_FOLDER = "activeAdventure.folderId";

/** The marked folder or null (if it was deleted, the mark itself no longer counts). */
function _adventureFolder() {
  try {
    const id = String(game.settings.get(MODULE_ID, SETTING_FOLDER) ?? "").trim();
    if (!id) return null;
    const f = game.folders?.get(id) ?? null;
    return (f && f.type === "Scene") ? f : null;
  } catch (_e) { return null; }
}

/**
 * Folder from a menu element: the folder header sits inside .folder[data-folder-id].
 *
 * ⚠️ Take the WORLD folder and only it. The same hook builds the menu in compendiums
 * (Compendium inherits DocumentDirectory), and a pack folder's id matches the world
 * one by design — adventure import preserves ids. Without the check a compendium
 * row would mark an unrelated world folder. Distinguish by uuid: a world folder has
 * "Folder.<id>", a pack folder has "Compendium.<pack>.Folder.<id>".
 */
function _folderFromLi(li) {
  const el = li?.dataset ? li : li?.[0];
  const row = el?.dataset?.folderId ? el : el?.closest?.("[data-folder-id]");
  const id = row?.dataset?.folderId;
  if (!id) return null;
  const uuid = String(row?.dataset?.uuid ?? "");
  if (uuid && !uuid.startsWith("Folder.")) return null;
  const f = game.folders?.get(id) ?? null;
  return (f && !f.pack) ? f : null;
}

/** Scene from a navbar menu element. */
function _sceneFromLi(li) {
  const el = li?.dataset ? li : li?.[0];
  const id = el?.dataset?.sceneId ?? el?.closest?.("[data-scene-id]")?.dataset?.sceneId;
  return id ? (game.scenes?.get(id) ?? null) : null;
}

/**
 * Ask for the copy's name. Returns a string or null (cancelled/empty).
 * ⚠️ DialogV2 substitutes the ACTION NAME when the callback returns null/undefined
 * (dialog.mjs: result ?? button.action) — so we normalize the result ourselves.
 */
async function _askName(defaultName) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const value = foundry.utils.escapeHTML(String(defaultName ?? ""));
  const content = `
    <p style="margin:0 0 8px">
      <label>${game.i18n.localize("ADM_LEVELS.activeAdventure.nameLabel")}<br>
        <input type="text" name="admName" value="${value}" style="width:100%" autofocus />
      </label>
    </p>`;
  const read = (el) => {
    const root = el?.[0] ?? el;
    const v = String(root?.querySelector?.("[name='admName']")?.value ?? "").trim();
    return v ? { name: v } : null;
  };

  if (DialogV2?.wait) {
    const res = await DialogV2.wait({
      window: { title: game.i18n.localize("ADM_LEVELS.activeAdventure.copyAndView") },
      content,
      buttons: [
        { action: "ok", label: "OK", default: true, callback: (_ev, _btn, dialog) => read(dialog?.element ?? dialog) },
        { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => ({}) },
      ],
      rejectClose: false,
      modal: true,
    }).catch(() => null);
    return (res && typeof res === "object" && res.name) ? res.name : null;
  }

  return await new Promise(resolve => {
    new Dialog({
      title: game.i18n.localize("ADM_LEVELS.activeAdventure.copyAndView"),
      content,
      buttons: {
        ok: { label: "OK", callback: (html) => resolve(read(html)?.name ?? null) },
        cancel: { label: game.i18n.localize("Cancel"), callback: () => resolve(null) },
      },
      default: "ok",
      close: () => resolve(null),
    }).render(true);
  });
}

/** Copy the scene into the marked folder and switch to the copy. */
async function _copyAndView(scene) {
  const name = await _askName(scene.name);
  if (!name) return;

  // ⚠️ Re-read the folder AFTER the dialog: it waits for the human indefinitely, and
  // the scene's folder field only validates the id FORMAT, not existence. With a
  // stale id the copy would silently land at the list root, while the toast would
  // report a folder that no longer exists.
  const folder = _adventureFolder();
  if (!folder) {
    ui.notifications?.warn?.(game.i18n.localize("ADM_LEVELS.activeAdventure.folderGone"));
    return;
  }

  let copy = null;
  try {
    // clone(save:true) strips _id, carries over all embedded docs (walls, lights, sounds,
    // notes, tiles, tokens) and REGENERATES the thumbnail.
    // ⚠️ Scene#clone forces active=false and navigation=false — passing them is
    // pointless; navigation, however, is restored afterwards (below).
    copy = await scene.clone({ name, folder: folder.id }, { save: true, addSource: true });
  } catch (e) {
    console.error("[ADM:activeAdventure] scene clone failed:", e);
    ui.notifications?.error?.(game.i18n.localize("ADM_LEVELS.activeAdventure.cloneFailed"));
    return;
  }
  if (!copy) {
    // create() returns empty when a foreign preCreate hook cancelled the creation.
    ui.notifications?.error?.(game.i18n.localize("ADM_LEVELS.activeAdventure.cloneEmpty"));
    console.error("[ADM:activeAdventure] clone returned nothing for scene", scene.name);
    return;
  }

  // Navbar: clone reset the flag, so we replicate the ORIGINAL's setting. Otherwise
  // the copy would vanish from navigation as soon as you leave it for another scene.
  if (scene.navigation) {
    try { await copy.update({ navigation: true }); }
    catch (e) { console.warn("[ADM:activeAdventure] copy navigation flag:", e); }
  }

  // ⚠️ view() does NOT throw when the canvas is already loading something: it silently
  // bails out, returning a notification id instead of the scene itself. Without checking
  // the result we would report a successful switch while leaving the GM on the old scene.
  let viewed = null;
  try { viewed = await copy.view(); }
  catch (e) { console.warn("[ADM:activeAdventure] switching to the copy:", e); }
  if (viewed !== copy) {
    ui.notifications?.warn?.(game.i18n.format("ADM_LEVELS.activeAdventure.createdNoView", { name: copy.name, folder: folder.name }));
    return;
  }
  ui.notifications?.info?.(game.i18n.format("ADM_LEVELS.activeAdventure.created", { name: copy.name, folder: folder.name }));
}

export const TOOL = {
  id: "activeAdventure",
  name: "ADM_LEVELS.settings.activeAdventure.name",
  hint: "ADM_LEVELS.settings.activeAdventure.hint",

  onInit() {
    // The mark lives in the world and survives a reload. config:false — it is managed
    // only via the folder menu; there is no reason to fiddle with it in module settings.
    game.settings.register(MODULE_ID, SETTING_FOLDER, {
      scope: "world",
      config: false,
      type: String,
      default: "",
    });
  },

  onReady({ isEnabled }) {
    // ── "Active adventure" entry in the folder right-click menu ──────────
    // The hook is shared by ALL sidebar directories (actors, items, journals…),
    // so we filter by the folder's own type, not by the application class.
    // Compendiums are cut off right away: they build the menu via the same hook (see _folderFromLi).
    //
    // ⚠️ isEnabled() is checked IN condition, not here: the hook fires EXACTLY ONCE
    // per application (_onFirstRender builds the menu and caches the array), while
    // condition is re-queried on every right-click. In the hook body the module
    // toggle would be read at world start and mean nothing until F5.
    Hooks.on("getFolderContextOptions", (app, options) => {
      if (app?.collection instanceof foundry.documents.collections.CompendiumCollection) return;
      if (!Array.isArray(options)) return;
      options.push({
        name: "ADM_LEVELS.activeAdventure.markFolder",
        icon: '<i class="fa-solid fa-flag"></i>',
        condition: (li) => isEnabled() && !!game.user?.isGM && _folderFromLi(li)?.type === "Scene",
        callback: async (li) => {
          const folder = _folderFromLi(li);
          if (!folder) return;
          // A second click on an ALREADY marked folder clears the mark: otherwise there
          // would be no way to remove it — the setting is hidden and the entry only assigns.
          const cur = String(game.settings.get(MODULE_ID, SETTING_FOLDER) ?? "");
          if (cur === folder.id) {
            await game.settings.set(MODULE_ID, SETTING_FOLDER, "");
            ui.notifications?.info?.(game.i18n.format("ADM_LEVELS.activeAdventure.unmarked", { folder: folder.name }));
            return;
          }
          await game.settings.set(MODULE_ID, SETTING_FOLDER, folder.id);
          ui.notifications?.info?.(game.i18n.format("ADM_LEVELS.activeAdventure.marked", { folder: folder.name }));
        },
      });
    });

    // ── "Copy and view" entry in the navbar scene right-click menu ───────
    Hooks.on("getSceneContextOptions", (_app, items) => {
      if (!Array.isArray(items)) return;
      items.push({
        name: "ADM_LEVELS.activeAdventure.copyAndView",
        icon: '<i class="fa-solid fa-clone"></i>',
        // Without a marked folder the entry is not shown at all — nowhere to put the copy.
        // isEnabled() is here too: the hook body runs only once (see above).
        condition: (li) => isEnabled() && !!game.user?.isGM
          && !!_adventureFolder() && !!_sceneFromLi(li),
        callback: async (li) => {
          const scene = _sceneFromLi(li);
          if (!scene) return;
          await _copyAndView(scene);
        },
      });
    });

    // Folder deleted — clear the mark, otherwise the entry would lead nowhere. ONE
    // client writes: every GM sees the deletion, and each would send its own setting update.
    Hooks.on("deleteFolder", async (folder) => {
      if (!isEnabled() || game.users?.activeGM !== game.user) return;
      try {
        if (String(game.settings.get(MODULE_ID, SETTING_FOLDER) ?? "") !== folder?.id) return;
        await game.settings.set(MODULE_ID, SETTING_FOLDER, "");
      } catch (e) { console.warn("[ADM:activeAdventure] clearing the mark:", e); }
    });
  },
};
