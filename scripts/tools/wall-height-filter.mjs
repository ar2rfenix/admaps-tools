// scripts/tools/wall-height-filter.mjs
// ADMaps Tools sub-module: in walls mode show ONLY the walls of the selected floor.
//
// Why: on a multi-floor scene the ground-floor walls lie on top of the roof walls and get in
// the way of editing them — the cursor hits the wrong one, the selection box grabs foreign walls.
//
// Wall height is stored by the wall-height module in the flags `wall-height.top` / `.bottom`.
// ⚠️ An unset height is NOT zero but INFINITY (wall-height/scripts/utils.js:
// `?? Infinity` / `?? -Infinity`), i.e. a "full-height" wall. Such walls cross every floor,
// hence a separate checkbox for them — otherwise the filter would not remove an unmarked ground floor.
//
// Hiding is done via `wall.visible = false`, and that is exactly what we need: the core itself excludes
// invisible placeables from selection (client/canvas/layers/base/placeables-layer.mjs,
// `*controllableObjects()` — `if (placeable.visible && placeable.renderable)`), and PIXI does not
// dispatch events to them. One property covers both "not visible" and "not selectable".

const MODULE_ID = "adm-levels";
const WH_SCOPE = "wall-height";

const S_ACTIVE = "wallFilter.active";
const S_MIN    = "wallFilter.min";
const S_MAX    = "wallFilter.max";
const S_UNSET  = "wallFilter.unset";

const PANEL_ID = "admaps-wall-height-filter";

const _get = (key, dflt) => { try { return game.settings.get(MODULE_ID, key); } catch { return dflt; } };
const _set = (key, val) => { try { return game.settings.set(MODULE_ID, key, val); } catch { return null; } };
const _t = (key, dflt) => { const s = game.i18n?.localize?.(key); return (s && s !== key) ? s : dflt; };

/**
 * Bound from a flag. ⚠️ First filter out "unset", and only then convert to a number:
 * `Number(null)` gives 0, and Foundry saves an empty height field exactly as `null`
 * (form-data-extended: empty number input → null). Through Number() such a wall would become
 * «0..0» and vanish on EVERY floor, and the «no height» checkbox would no longer bring it back.
 * The semantics mirror the flag's owner (wall-height/scripts/utils.js, the `??` operator).
 */
const _bound = (raw, inf) => {
  if (raw === null || raw === undefined || raw === "") return inf;
  const n = Number(raw);
  return Number.isFinite(n) ? n : inf;
};

function _wallBounds(doc) {
  const f = doc?.flags?.[WH_SCOPE] ?? {};
  return { top: _bound(f.top, Infinity), bottom: _bound(f.bottom, -Infinity) };
}

/** No height markup at all — both bounds are infinite. */
const _isUnbounded = (b) => !Number.isFinite(b.top) && !Number.isFinite(b.bottom);

/**
 * Whether to show a wall for the range [lo, hi).
 * ⚠️ BOTH ends are exclusive — the interval is open on both sides:
 *   • a wall that ENDS exactly at «bottom» belongs to the floor BELOW;
 *   • a wall that STARTS exactly at «top» belongs to the floor ABOVE.
 * Otherwise the filter would work in one direction only: editing the ground floor (0–15), you would still
 * see roof walls starting exactly at 15. Levels itself uses the same convention.
 * ⚠️ A degenerate range (top ≤ bottom, incl. the 0/0 default) is treated as "top unset",
 * otherwise the screen would go completely empty on the very first enable.
 */
function _wallPasses(doc, lo, hi, showUnset) {
  const b = _wallBounds(doc);
  if (_isUnbounded(b)) return !!showUnset;
  const _hi = (hi > lo) ? hi : Infinity;
  return b.top > lo && b.bottom < _hi;
}

/** Is the filter active right now. isEnabled is passed in from the sub-module registry. */
let _isToolEnabled = () => true;
const _filterOn = () => !!_isToolEnabled() && !!_get(S_ACTIVE, false) && !!canvas?.walls?.active;

/** Apply/remove the filter on every wall of the scene. */
function _apply() {
  const layer = canvas?.walls;
  if (!layer?.placeables) return;

  const on = _filterOn();
  const lo = Number(_get(S_MIN, 0)) || 0;
  const hi = Number(_get(S_MAX, 0)) || 0;
  const showUnset = !!_get(S_UNSET, true);

  for (const wall of layer.placeables) {
    const show = !on || _wallPasses(wall.document, lo, hi, showUnset);
    // ⚠️ Release selection BEFORE the early exit: a hidden wall may turn out to be selected
    // and without this it would move along with the visible ones when dragging (the Alt-chain selects
    // invisible walls too — it does not go through controllableObjects).
    if (!show && wall.controlled) wall.release();
    if (wall.visible === show) continue;
    wall.visible = show;
  }
}

/** Decision for ONE wall — for targeted re-application. */
function _applyOne(wall) {
  if (!wall?.document) return;
  const show = !_filterOn() || _wallPasses(
    wall.document,
    Number(_get(S_MIN, 0)) || 0,
    Number(_get(S_MAX, 0)) || 0,
    !!_get(S_UNSET, true),
  );
  if (!show && wall.controlled) wall.release();
  if (wall.visible !== show) wall.visible = show;
}

/* ───────────────────────── panel ───────────────────────── */

const _panel = () => document.getElementById(PANEL_ID);

function _syncPanelVisible() {
  const el = _panel();
  if (!el) return;
  el.style.display = _filterOn() ? "flex" : "none";
}

function _buildPanel() {
  if (_panel()) return _panel();
  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.style.cssText = [
    // ⚠️ Fixed position on purpose. The "compute from the layout" variant (#scene-navigation /
    // #ui-left) in v13 pushed the panel down towards the screen centre — verified live by the owner.
    "position:absolute", "top:12px", "left:230px",
    "z-index:70", "display:none", "gap:8px", "align-items:center",
    "padding:6px 10px", "border-radius:8px",
    "background:rgba(0,0,0,.75)", "border:1px solid rgba(255,255,255,.25)",
    "color:#eee", "font-size:12px", "pointer-events:auto",
  ].join(";");

  const esc = foundry.utils.escapeHTML;
  const numStyle = "width:58px;height:22px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:4px;padding:0 4px;";
  el.innerHTML = `
    <span style="opacity:.8;white-space:nowrap;" data-tooltip="${esc(_t("ADM_LEVELS.wallHeightFilter.floorTip", "Shows the walls of the selected floor. A wall that ends exactly at «bottom», or starts exactly at «top», belongs to the neighbouring floor and is hidden. If «top» is not greater than «bottom», the upper bound counts as unset."))}">${esc(_t("ADM_LEVELS.wallHeightFilter.floor", "Floor:"))}</span>
    <label style="display:flex;align-items:center;gap:4px;">${esc(_t("ADM_LEVELS.wallHeightFilter.bottom", "bottom"))}<input type="number" data-wf="min" step="1" style="${numStyle}"/></label>
    <label style="display:flex;align-items:center;gap:4px;">${esc(_t("ADM_LEVELS.wallHeightFilter.top", "top"))}<input type="number" data-wf="max" step="1" style="${numStyle}"/></label>
    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;" data-tooltip="${esc(_t("ADM_LEVELS.wallHeightFilter.unsetTip", "Walls with no height set at all count as full-height (from −∞ to +∞) and cross every floor. Uncheck to hide them as well."))}">
      <input type="checkbox" data-wf="unset" style="margin:0;"/>${esc(_t("ADM_LEVELS.wallHeightFilter.unset", "no height"))}
    </label>`;

  document.body.appendChild(el);

  el.querySelector('[data-wf="min"]').value = String(_get(S_MIN, 0) ?? 0);
  el.querySelector('[data-wf="max"]').value = String(_get(S_MAX, 0) ?? 0);
  el.querySelector('[data-wf="unset"]').checked = !!_get(S_UNSET, true);

  el.addEventListener("change", async (ev) => {
    const t = ev.target;
    const key = t?.dataset?.wf;
    if (!key) return;
    if (key === "min") await _set(S_MIN, Math.trunc(Number(t.value) || 0));
    else if (key === "max") await _set(S_MAX, Math.trunc(Number(t.value) || 0));
    else if (key === "unset") await _set(S_UNSET, !!t.checked);
    _apply();
  });
  // So that clicks/wheel inside the panel do not leak to the canvas.
  for (const evt of ["pointerdown", "wheel", "click"]) el.addEventListener(evt, (e) => e.stopPropagation());

  return el;
}

export const TOOL = {
  id: "wallHeightFilter",
  name: "ADM_LEVELS.settings.wallHeightFilter.name",
  hint: "ADM_LEVELS.settings.wallHeightFilter.hint",
  // ⚠️ Unticking the checkbox on the fly does not bring hidden walls back until the next layer event
  // (the settings menu does not fire our hooks) — it is cleaner to ask for a reload.
  requiresReload: true,

  onInit({ moduleId }) {
    const id = moduleId ?? MODULE_ID;
    const reg = (key, type, dflt) => game.settings.register(id, key, {
      scope: "client", config: false, type, default: dflt,
    });
    reg(S_ACTIVE, Boolean, false);
    reg(S_MIN, Number, 0);
    reg(S_MAX, Number, 0);
    reg(S_UNSET, Boolean, true);
  },

  onReady({ isEnabled }) {
    // ⚠️ Keep the enabled gate INSIDE _filterOn, not at the entry of the handlers: otherwise
    // unticking the sub-module checkbox on the fly would leave the walls hidden forever — there would be
    // nothing to bring them back, because the restore path would have disabled itself.
    _isToolEnabled = () => { try { return !!isEnabled(); } catch { return false; } };

    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM) return;
      const tools = controls?.walls?.tools;
      if (!tools) return;
      tools.admapsWallHeightFilter = {
        name: "admapsWallHeightFilter",
        title: "ADM_LEVELS.settings.wallHeightFilter.name",
        icon: "fas fa-layer-group",
        toggle: true,
        active: !!_get(S_ACTIVE, false),
        onChange: async (_ev, active) => {
          await _set(S_ACTIVE, !!active);
          _buildPanel();
          _syncPanelVisible();
          _apply();
        },
      };
    });

    const refresh = () => { _buildPanel(); _syncPanelVisible(); _apply(); };

    // ⚠️ Specifically refreshWall, NOT drawWall: the core restores visible in draw() RIGHT AFTER
    // calling the draw hook (placeable-object.mjs: callAll(`draw…`) at 432, `this.visible =
    // wasVisible` at 435) — a write from drawWall would be overwritten immediately. refreshWall is called from
    // applyRenderFlags after the restore, so the decision survives.
    Hooks.on("refreshWall", (wall) => { if (_filterOn()) _applyOne(wall); });

    Hooks.on("createWall", refresh);
    Hooks.on("updateWall", refresh);   // height changed — recompute
    Hooks.on("canvasReady", refresh);
    Hooks.on("activateWallsLayer", refresh);
    // Leaving the walls layer restores everything as it was: the filter is an editor tool, not a scene one.
    Hooks.on("deactivateWallsLayer", refresh);
    Hooks.on("renderSceneControls", () => { _syncPanelVisible(); });
  },
};
