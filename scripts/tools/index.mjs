// scripts/tools/index.mjs
// Registry of the internal ADMaps Tools sub-modules.
//
// Each sub-module is a SEPARATE FILE in this folder and exports a descriptor:
//   export const TOOL = {
//     id,                    // unique key (latin letters) → setting key `tool.<id>`
//     name, hint,            // i18n keys for the checkbox in the module settings
//     replaces?: [ ... ],    // ids of the old standalone modules this sub-module REPLACES
//     requiresReload?: bool, // whether F5 is needed to apply the checkbox toggle
//     settingScope?: "client", // checkbox scope (default "world"); "client" = each player decides
//     defaultEnabled?: false,  // checkbox default (default true = ON)
//     onInit?({ isEnabled }),// (optional) called in Hooks.once("init") — for its own game.settings.register
//     onReady({ isEnabled }),// called on Foundry "ready" (unless deferred because of an old module)
//   }
//
// TO ADD A SUB-MODULE: create tools/<name>.mjs with export const TOOL, import it below and
// append it to the TOOLS array. The checkbox, startup and auto-disabling of the old module are picked up automatically.

import { TOOL as roofFogFix } from "./roof-fog-fix.mjs";
import { TOOL as tokenSort } from "./token-sort.mjs";
import { TOOL as teleportFix } from "./teleport-fix.mjs";
import { TOOL as tokenReanimator } from "./token-reanimator.mjs";
import { TOOL as tokenDrop } from "./token-drop.mjs";
import { TOOL as tileControl } from "./tile-control.mjs";
import { TOOL as propsAutoPos } from "./props-auto-pos.mjs";
import { TOOL as sceneFlip } from "./scene-flip.mjs";
import { TOOL as sceneSwitch } from "./scene-switch.mjs";
import { TOOL as backgroundFreeze } from "./background-freeze.mjs";
import { TOOL as filePreview } from "./file-preview.mjs";
import { TOOL as sceneExportName } from "./scene-export-name.mjs";
import { TOOL as tileScroll } from "./tile-scroll.mjs";
import { TOOL as tilePartialFade } from "./tile-partial-fade.mjs";
import { TOOL as tileHoverLink } from "./tile-hover-link.mjs";
import { TOOL as sceneRecord } from "./scene-record.mjs";
import { TOOL as wallHeightFilter } from "./wall-height-filter.mjs";
import { TOOL as massEditMirrorFix } from "./massedit-mirror-fix.mjs";
import { TOOL as teleportPair } from "./teleport-pair.mjs";
import { TOOL as teleportStepBack } from "./teleport-step-back.mjs";
import { TOOL as activeAdventure } from "./active-adventure.mjs";
import { TOOL as levelsFollowToken } from "./levels-follow-token.mjs";
import { TOOL as levelsGhostTokens } from "./levels-ghost-tokens.mjs";
import { TOOL as levelsEffectFloors } from "./levels-effect-floors.mjs";
import { TOOL as levelsFloorTransit } from "./levels-floor-transit.mjs";
import { TOOL as levelsStairGate } from "./levels-stair-gate.mjs";
import { TOOL as levelsFastRoofFade } from "./levels-fast-roof-fade.mjs";
import { TOOL as doorUnderToken } from "./door-under-token.mjs";
import { TOOL as doorMeshElevation } from "./door-mesh-elevation.mjs";
import { TOOL as doorSwingPreview } from "./door-swing-preview.mjs";
import { TOOL as doorInvert } from "./door-invert.mjs";
import { TOOL as doorQuick } from "./door-quick.mjs";
import { TOOL as moveWallElevation } from "./move-wall-elevation.mjs";
import { TOOL as sceneFolderImport } from "./scene-folder-import.mjs";
import { TOOL as sceneQuickExport } from "./scene-quick-export.mjs";
import { TOOL as regionFromTile } from "./region-from-tile.mjs";
import { TOOL as wallChainClick } from "./wall-chain-click.mjs";
// HIDDEN (the file tools/cinema.mjs is still in place, nothing deleted): no import → the module is not loaded,
// the settings checkbox is not registered, onInit/onReady are not called. To restore = uncomment
// this line AND the `cinema` entry in the TOOLS array below. Saved `cinema.*` values in the database
// stay untouched (Foundry ignores unregistered settings) — they come back together with the tool.
// import { TOOL as cinema } from "./cinema.mjs";

const MODULE_ID = "adm-levels";
const SETTING_PREFIX = "tool."; // sub-module setting key: tool.<id>

// All sub-modules. For a new one — import it above and add it here.
const TOOLS = [
  roofFogFix,
  tokenSort,
  teleportFix,
  tokenReanimator,
  tokenDrop,
  tileControl,
  propsAutoPos,
  sceneFlip,
  sceneSwitch,
  backgroundFreeze,
  filePreview,
  sceneExportName,
  tileScroll,
  tilePartialFade,
  tileHoverLink,
  sceneRecord,
  wallHeightFilter,
  massEditMirrorFix,
  teleportPair,
  teleportStepBack,
  activeAdventure,
  levelsFollowToken,
  levelsGhostTokens,
  levelsEffectFloors,
  levelsFloorTransit,
  levelsStairGate,
  levelsFastRoofFade,
  doorUnderToken,
  doorMeshElevation,
  doorSwingPreview,
  doorInvert,
  doorQuick,
  moveWallElevation,
  sceneFolderImport,
  sceneQuickExport,
  regionFromTile,
  wallChainClick,
  // hidden — see the commented-out import above; to restore = remove the «//» from the next line:
  // cinema,
];

const _key = (id) => `${SETTING_PREFIX}${id}`;

/** ids of the old modules (from .replaces) that are CURRENTLY LOADED (active in this session) —
 *  their presence would cause a duplicate, so the corresponding sub-module is deferred. */
function _loadedReplacedBy(tool) {
  return (tool?.replaces ?? []).filter((id) => id && game.modules.get(id)?.active);
}

/** Whether the sub-module is enabled (checkbox). The checkbox default comes from the descriptor (defaultEnabled,
 *  usually ON); on a read error (before registration) answer with the tool's default. */
export function isToolEnabled(id) {
  try { return game.settings.get(MODULE_ID, _key(id)) !== false; }
  catch { return TOOLS.find((t) => t?.id === id)?.defaultEnabled !== false; }
}

/** init hooks of the sub-modules (for their own game.settings.register). Call in Hooks.once("init")
 *  BEFORE registerToolSettings — but both can be called from the same init. */
export function initTools() {
  for (const tool of TOOLS) {
    if (typeof tool?.onInit !== "function") continue;
    try { tool.onInit({ isEnabled: () => isToolEnabled(tool.id), moduleId: MODULE_ID }); }
    catch (e) { console.warn(`[ADM:Tools] sub-module "${tool?.id}" failed in onInit:`, e); }
  }
}

/** Registers the sub-module checkbox settings. Call in Hooks.once("init"). */
export function registerToolSettings() {
  for (const tool of TOOLS) {
    if (!tool?.id) continue;
    game.settings.register(MODULE_ID, _key(tool.id), {
      name: tool.name ?? tool.id,
      hint: tool.hint ?? "",
      scope: tool.settingScope === "client" ? "client" : "world",
      config: true,          // → shows up as a checkbox in the module settings
      type: Boolean,
      default: tool.defaultEnabled !== false, // ON unless the descriptor says otherwise
      requiresReload: !!tool.requiresReload,
    });
  }
}

/** Moves the hints of ALL OUR settings (sub-module checkboxes and their options) from the text-below-the-row
 *  into a tooltip (ⓘ icon next to the name) — otherwise the descriptions bloat the settings panel.
 *  A setting without a hint is left with no explanation at all. Call once. */
let _hintHookInstalled = false;
export function installSettingsHintTooltips() {
  if (_hintHookInstalled) return;
  _hintHookInstalled = true;
  Hooks.on("renderSettingsConfig", (_app, element) => {
    const root = element instanceof HTMLElement ? element : (element?.[0] ?? element);
    if (!root?.querySelectorAll) return;
    for (const input of root.querySelectorAll(`[name^="${MODULE_ID}."]`)) {
      const group = input.closest(".form-group");
      if (!group || group.dataset.admHintMoved) continue;
      const hintEl = group.querySelector(".hint, .notes");
      const text = hintEl?.textContent?.trim();
      if (!text) continue;
      const label = group.querySelector("label");
      if (label) {
        const ico = document.createElement("i");
        ico.className = "fa-solid fa-circle-info";
        ico.setAttribute("data-tooltip", text);
        ico.setAttribute("data-tooltip-direction", "UP");
        ico.style.cssText = "margin-left:6px;opacity:0.55;cursor:help;font-size:12px;";
        label.appendChild(ico);
      }
      hintEl.remove();               // remove the hint text from under the checkbox
      group.dataset.admHintMoved = "1";
    }
  });
}

/** Starts the sub-modules. Call in Hooks.once("ready"). onReady is called for all EXCEPT those
 *  whose old standalone module is still LOADED in this session (to avoid a duplicate — the old
 *  module does the work itself; the built-in one takes over after a reload, once the old one is disabled). */
export function startTools() {
  for (const tool of TOOLS) {
    if (typeof tool?.onReady !== "function") continue;
    const stillOld = _loadedReplacedBy(tool);
    if (stillOld.length) {
      console.warn(`[ADM:Tools] sub-module "${tool.id}" deferred: old module ${stillOld.join(", ")} is still active (it is disabled after a reload).`);
      continue;
    }
    try {
      tool.onReady({ isEnabled: () => isToolEnabled(tool.id), moduleId: MODULE_ID });
    } catch (e) {
      console.warn(`[ADM:Tools] sub-module "${tool?.id}" failed in onReady:`, e);
    }
  }
}

/** Auto-disables the old standalone modules that are now built in (by .replaces).
 *  Catches two cases: (a) the module is LOADED → there would be a duplicate; (b) the module is active in the config, but its folder
 *  is deleted ("active but missing" warning). In both cases we write core.moduleConfiguration=false.
 *  GM-only. Call on ready. Offers a reload if anything was disabled. */
export async function handleSupersededModules() {
  if (!game.user?.isGM) return;
  let cfg;
  try { cfg = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration") ?? {}); }
  catch { return; }

  const loaded = [];   // actually loaded → shown in the dialog
  const ids = new Set();
  for (const tool of TOOLS) for (const id of (tool.replaces ?? [])) {
    if (!id) continue;
    const isLoaded = !!game.modules.get(id)?.active;
    if (isLoaded || cfg[id] === true) ids.add(id);
    if (isLoaded) loaded.push(id);
  }
  if (!ids.size) return;

  let changed = false;
  for (const id of ids) if (cfg[id] !== false) { cfg[id] = false; changed = true; }
  if (!changed) return;
  try { await game.settings.set("core", "moduleConfiguration", cfg); }
  catch (e) {
    console.warn("[ADM:Tools] failed to disable the old modules:", e);
    return;
  }

  // Offer a reload only if something is actually LOADED (otherwise there is no duplicate in the session —
  // we just cleaned "active but missing" entries out of the config, the reload is not urgent).
  const titles = [...ids].map((id) => game.modules.get(id)?.title ?? id);
  const content = `<p>${game.i18n.localize("ADM_LEVELS.tools.supersededIntro")}</p>
    <ul style="margin:6px 0 10px 18px;">${titles.map((t) => `<li>${foundry.utils.escapeHTML(String(t))}</li>`).join("")}</ul>
    <p>${game.i18n.localize(loaded.length ? "ADM_LEVELS.tools.supersededReloadNow" : "ADM_LEVELS.tools.supersededReloadLater")}</p>`;
  try {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (loaded.length && DialogV2?.confirm) {
      const reload = await DialogV2.confirm({
        window: { title: "ADMaps Tools", icon: "fa-solid fa-toolbox" },
        content, modal: true, rejectClose: false,
      });
      if (reload) location.reload();
    } else {
      ui.notifications?.info(game.i18n.format("ADM_LEVELS.tools.supersededDisabled", { titles: titles.join(", ") }));
    }
  } catch (_e) { /* dialog closed — nothing to do */ }
}
