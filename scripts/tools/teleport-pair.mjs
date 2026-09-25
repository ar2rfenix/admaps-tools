// scripts/tools/teleport-pair.mjs
// ADMaps Tools sub-module: link TWO regions with a paired teleport in one go.
//
// Why: linking a staircase between floors by hand means opening a region, adding
// a «Teleport Token» behavior, finding the second region in the list, enabling
// «Ask for confirmation», then repeating it all mirrored. Six steps for
// a single link, and half the time goes to hunting the right region among
// identically named ones.
//
// ⚠️ SELECTION IS BY LISTS, NOT BY SELECTING ON THE CANVAS. The first version asked to select
// two regions and linked them: on the regions layer you CANNOT select two at once, and
// the button would have been dead. A dialog with lists does not depend on the selection
// method at all — and also solves the problem of identically named regions (they get numbered).
//
// ⚠️ The destination is stored as a Region UUID «Scene.<sceneId>.Region.<regionId>»
// (DocumentUUIDField({type:"Region"})), so we link regions of ONE scene.
// Cross-scene links are not done here: they have a different scenario and their own pitfalls —
// when a scene is copied such references go stale (see the teleport-fix sub-module).

const MODULE_ID = "adm-levels";

/** Type of the built-in Foundry behavior (verified against the core: RegionBehavior coreTypes). */
const BEHAVIOR_TYPE = "teleportToken";

/** Name of the created behavior. English and NOT localizable — see the comment
 *  at createEmbeddedDocuments below. Matches Foundry's own default. */
const BEHAVIOR_NAME = "Teleport Token";

const _t = (key, dflt) => { const s = game.i18n?.localize?.(key); return (s && s !== key) ? s : dflt; };
const _notify = (msg, type = "info") => { try { ui.notifications?.[type]?.(msg); } catch (_e) {} };
const _esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Is there already a teleport from here to exactly this region? Then don't create a duplicate. */
function _hasTeleportTo(regionDoc, destUuid) {
  for (const b of (regionDoc?.behaviors ?? [])) {
    if (String(b?.type ?? "") !== BEHAVIOR_TYPE) continue;
    if (String(b?.system?.destination ?? "") === String(destUuid)) return true;
  }
  return false;
}

/**
 * Create a one-way link from → to.
 * @returns {"created"|"exists"} what actually happened — for an accurate report
 */
async function _linkOneWay(from, to) {
  const destUuid = to.uuid;   // «Scene.<sceneId>.Region.<regionId>»
  if (_hasTeleportTo(from, destUuid)) return "exists";
  await from.createEmbeddedDocuments("RegionBehavior", [{
    // ⚠️ The name is NOT localized: this is scene DATA, not a UI label. Localizing it
    // here would cause inconsistency — already created links would keep the language that was
    // active at the moment of creation. We write it the way Foundry itself does, in English.
    // Nothing depends on this name: both the core and the teleport-fix sub-module look up the
    // behavior by type === "teleportToken", so it can be renamed by hand.
    name: BEHAVIOR_NAME,
    type: BEHAVIOR_TYPE,
    system: {
      destination: destUuid,
      // «Ask for confirmation» — at the author's request ALWAYS enabled:
      // a silent teleport on a staircase carries the token away against the player's intent.
      choice: true,
    },
  }]);
  return "created";
}

/** Region labels for the list.
 *
 *  ⚠️ Names repeat («1 floor» on every floor), and picking the right one blindly
 *  would be impossible. An id tail solved that, but it is painful to read and carries no
 *  information. So we number ONLY the duplicates: unique names stay clean,
 *  and repeated ones get «(1)», «(2)» in scene order.
 */
function _regionLabels(regions) {
  const unnamed = _t("ADM_LEVELS.teleportPair.unnamed", "Unnamed");
  const names = regions.map(r => String(r?.name ?? "").trim() || unnamed);
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const seen = new Map();
  return names.map(n => {
    if ((counts.get(n) ?? 0) < 2) return n;
    const i = (seen.get(n) ?? 0) + 1;
    seen.set(n, i);
    return `${n} (${i})`;
  });
}

function _optionsHTML(regions, selectedId) {
  const labels = _regionLabels(regions);
  return regions.map((r, i) =>
    `<option value="${_esc(r.id)}"${r.id === selectedId ? " selected" : ""}>${_esc(labels[i])}</option>`
  ).join("");
}

async function _openPairDialog() {
  if (!game.user?.isGM) return;
  const scene = canvas?.scene;
  const regions = [...(scene?.regions ?? [])];

  if (regions.length < 2) {
    _notify(_t("ADM_LEVELS.teleportPair.needTwoOnScene", "The scene needs at least two regions."), "warn");
    return;
  }

  // If one region is selected after all — put it first, this is a common case.
  const preId = (canvas?.regions?.controlled?.length === 1)
    ? canvas.regions.controlled[0]?.document?.id : null;
  const aId = preId ?? regions[0].id;
  const bId = (regions.find(r => r.id !== aId) ?? regions[1]).id;

  const lblFrom = _esc(_t("ADM_LEVELS.teleportPair.from", "First region"));
  const lblTo = _esc(_t("ADM_LEVELS.teleportPair.to", "Second region"));
  const note = _esc(_t("ADM_LEVELS.teleportPair.note",
    "The teleport is created both ways, with \"Ask for confirmation\" enabled."));

  const content = `
    <div class="admaps-tp-pair" style="display:flex;flex-direction:column;gap:8px;">
      <label style="display:flex;flex-direction:column;gap:3px;">
        <span>${lblFrom}</span>
        <select name="tpFrom">${_optionsHTML(regions, aId)}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:3px;">
        <span>${lblTo}</span>
        <select name="tpTo">${_optionsHTML(regions, bId)}</select>
      </label>
      <p style="margin:0;opacity:.75;font-size:12px;">${note}</p>
    </div>`;

  const DialogV2 = foundry.applications.api.DialogV2;
  await DialogV2.wait({
    window: {
      title: _t("ADM_LEVELS.settings.teleportPair.name", "Paired region teleport"),
      icon: "fa-solid fa-right-left",
    },
    position: { width: 420 },
    content,
    buttons: [
      {
        action: "link",
        label: _t("ADM_LEVELS.teleportPair.link", "Link"),
        icon: "fa-solid fa-link",
        default: true,
        callback: async (_event, _button, dialog) => {
          const root = dialog?.element ?? null;
          const fromId = root?.querySelector?.('[name="tpFrom"]')?.value ?? "";
          const toId = root?.querySelector?.('[name="tpTo"]')?.value ?? "";
          await _linkPair(scene, fromId, toId);
        },
      },
      { action: "cancel", label: _t("ADM_LEVELS.teleportPair.cancel", "Cancel"), icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });
}

/** Link two regions by id — both directions, no duplicates. */
async function _linkPair(scene, fromId, toId) {
  const a = scene?.regions?.get(String(fromId));
  const b = scene?.regions?.get(String(toId));
  if (!a || !b) {
    _notify(_t("ADM_LEVELS.teleportPair.notFound", "Region not found."), "warn");
    return;
  }
  if (a.id === b.id) {
    _notify(_t("ADM_LEVELS.teleportPair.sameRegion", "The same region is selected twice."), "warn");
    return;
  }

  try {
    const r1 = await _linkOneWay(a, b);
    const r2 = await _linkOneWay(b, a);
    const created = [r1, r2].filter(x => x === "created").length;
    if (created === 0) {
      _notify(_t("ADM_LEVELS.teleportPair.already", "These regions are already linked by a teleport."), "info");
    } else if (created === 1) {
      // A one-way link existed — we added the reverse one. Say so explicitly,
      // otherwise it looks like «nothing happened».
      _notify(_t("ADM_LEVELS.teleportPair.completed", "Added the reverse direction — the link is now two-way."), "info");
    } else {
      _notify(_t("ADM_LEVELS.teleportPair.created", "Teleport created both ways."), "info");
    }
  } catch (e) {
    console.error("[ADMaps Tools | teleport-pair]", e);
    _notify(_t("ADM_LEVELS.teleportPair.failed", "Could not create the teleport — see the console."), "error");
  }
}

export const TOOL = {
  id: "teleportPair",
  name: "ADM_LEVELS.settings.teleportPair.name",
  hint: "ADM_LEVELS.settings.teleportPair.hint",
  // The button is attached via the controls hook, which fires on every layer change,
  // so toggling the checkbox is picked up without a reload.
  requiresReload: false,

  onReady({ isEnabled }) {
    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM) return;
      const tools = controls?.regions?.tools;
      if (!tools) return;
      tools.admapsTeleportPair = {
        name: "admapsTeleportPair",
        title: "ADM_LEVELS.settings.teleportPair.name",
        icon: "fas fa-right-left",
        // The stock region tools occupy order 1..5 — we go right after, otherwise
        // the button sorts unpredictably and jumps between re-renders.
        order: 6,
        visible: game.user.isGM,
        // Not a toggle: this is a one-off action, not a mode. The «button + onChange» contract
        // is borrowed from the core's stock action buttons (e.g. «Clear Drawings»).
        button: true,
        onChange: () => { _openPairDialog(); },
      };
    });
  },
};
