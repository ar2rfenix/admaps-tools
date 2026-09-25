// scripts/tools/levels-follow-token.mjs
// ADMaps Tools sub-module: "Floor follows token".
//
// WHY. In the third-party Levels module the perspective follows the SELECTED token (levels/scripts/main.js:6):
//   controlToken → CONFIG.Levels.currentToken = controlled[0]
//   and for the GM with nothing selected — currentToken = null.
// An ELEVATION change of the selected token in the same place (main.js:1) only redraws placeables,
// it does NOT move the floor list in the panel. So for a player "everything is automatic" (their token is always
// selected), but when the GM climbs the stairs to the roof, the panel on the left still shows the first
// floor; as soon as the selection is dropped, currentToken becomes null and the view falls back to it.
//
// WHAT WE DO. While a token is selected — drive the floor panel after it (both on selection and on
// elevation change). Deselected — we stay on the floor we arrived at: this happens by itself,
// because we keep CONFIG.Levels.UI.range in sync with the token, and that is exactly what the
// perspective reads when currentToken is empty.
//
// ⚠️ We do NOT call UI._onChangeLevel: the first thing it does is canvas.tokens.releaseAll()
// (levels/scripts/ui.js:190) — that would deselect the token the GM has just moved,
// and the perspective would immediately drop. We repeat its useful part without that line.

const LEVELS_ID = "levels";
const MODULE_ID = "adm-levels";
const S_PANEL_ALTW = "levelsPanelAltW"; // second, independent checkbox of this sub-module

/** Active scene "floors" list: [bottom, top, name] (values are STRINGS). */
function _definedLevels() {
  const ui = CONFIG.Levels?.UI;
  const fromUi = ui?.definedLevels;
  if (Array.isArray(fromUi) && fromUi.length) return fromUi;
  const flag = canvas?.scene?.getFlag?.(LEVELS_ID, "sceneLevels");
  return Array.isArray(flag) ? flag : [];
}

/** The floor covering an elevation. The upper bound is NOT inclusive: with adjacent floors
 *  0–15 and 15–30, a token at 15 must count as being on the SECOND one, not the first. */
function _levelForElevation(elev) {
  const e = Number(elev);
  if (!Number.isFinite(e)) return null;
  for (const l of _definedLevels()) {
    const b = parseFloat(l?.[0]);
    const t = parseFloat(l?.[1]);
    if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
    if (e >= b && e < t) return l;
  }
  return null; // above the top floor / below the bottom one — leave the panel alone
}

/** Highlight the floor row in the panel (class active), the way _onChangeLevel does. */
function _highlightRow(entry) {
  try {
    const ui = CONFIG.Levels?.UI;
    const rootRaw = ui?.element;
    const root = rootRaw?.jquery ? rootRaw[0] : rootRaw;
    if (!root?.querySelectorAll) return;
    const rows = root.querySelectorAll(".level-item");
    if (!rows.length) return;
    const wantB = String(entry?.[0] ?? "").trim();
    const wantT = String(entry?.[1] ?? "").trim();
    for (const row of rows) {
      const b = String(row.querySelector(".level-bottom")?.value ?? "").trim();
      const t = String(row.querySelector(".level-top")?.value ?? "").trim();
      const hit = (b === wantB && t === wantT);
      row.classList.toggle("active", hit);
      const caret = row.querySelector(".fa-caret-right");
      if (caret) caret.classList.toggle("active", hit);
    }
  } catch (e) { console.warn("[adm-levels] follow-token: row highlight", e); }
}

/** Switch the panel to the floor matching the token's elevation. */
function _followElevation(elev) {
  const ui = CONFIG.Levels?.UI;
  if (!ui) return;
  const entry = _levelForElevation(elev);
  if (!entry) return;
  const cur = ui.range;
  // Already on the right floor — skip the recompute (it pulls in refreshAll + perception).
  if (Array.isArray(cur)
      && String(cur[0]) === String(entry[0])
      && String(cur[1]) === String(entry[1])) return;
  ui.range = entry;
  // ⚠️ Without this flag NOBODY reads the selected floor: Levels sets
  // rangeEnabled only when the window renders and clears it on close, and the
  // currentRange getter and tileHandler return the background elevation when the flag is off. This is what
  // keeps the promise "deselect — you stay on the floor": otherwise the view would
  // fall to the ground on deselection.
  ui.rangeEnabled = true;
  try { ui.activateForeground?.(); } catch (_e) {}
  ui.computeLevelsVisibility();          // takes no arguments — reads this.range
  _highlightRow(entry);
  // ⚠️ Announce the floor change. External listeners subscribe to it — the row
  // of floor buttons under the clocks (the system, clock-floor-switch.mjs) recolors
  // the active button. Without this, selecting a token changed the floor but the highlight lied.
  Hooks.callAll("levelsUiChangeLevel");
}

/** Scene controls toolbar. A separate helper — so it is not confused with the local
 *  variable `ui`, which in this file names the Levels floor window. */
function ui2Controls() {
  return globalThis.ui?.controls ?? null;
}

/** The floor window was opened BY Alt+W: what the floor view was before, and whether a floor was
 *  picked since (a level click or a token followed). null — Alt+W did not open the window, so
 *  Alt+W does not close it either (the GM opened it by hand). */
let _altWPanel = null;

/** Put the floor view back after the window closed: Levels' close() drops it
 *  (levels/scripts/ui.js close: rangeEnabled = false) — and the floor lives without the window
 *  too (see _followElevation). Same steps as there. */
function _restoreFloor(range) {
  const ui = CONFIG.Levels?.UI;
  if (!ui || !Array.isArray(range)) return;
  ui.range = range;
  ui.rangeEnabled = true;
  try { ui.activateForeground?.(); } catch (_e) {}
  ui.computeLevelsVisibility();
  _highlightRow(range);
  Hooks.callAll("levelsUiChangeLevel");
}

/** Put the selected token's eye height back into wall-height after a Levels floor recompute.
 *  LevelsUI#computeLevelsVisibility writes the floor BOTTOM there (levels/scripts/ui.js:
 *  WallHeight.currentTokenElevation = range[0]) — meant for the no-token floor view: Levels itself
 *  calls it after releasing the tokens. With a token selected (_followElevation, _restoreFloor,
 *  Levels' own close() on Alt+W) the token's eyes were replaced by the floor bottom until the token's
 *  next update, and wall-height shows a door icon while bottom <= eyes <= top: at the floor bottom 0
 *  the doors of the floor below (−15..0) passed as well (23.09.2026: «switched to level 1, clicked
 *  Celeste standing on 0 — door icons of the floor below appeared; moved her — they vanished»). */
function _keepTokenEyes() {
  const wh = globalThis.WallHeight;
  if (typeof wh?.updateCurrentTokenElevation !== "function") return;
  if (!canvas?.tokens?.controlled?.length) return; // no token — the floor bottom is the view, as Levels means it
  wh.updateCurrentTokenElevation();
}

/** Does the scene have declared floors (the Levels panel list). */
function _sceneHasLevels(scene) {
  const flag = scene?.getFlag?.(LEVELS_ID, "sceneLevels");
  return Array.isArray(flag) && flag.length > 0;
}

export const TOOL = {
  id: "levelsFollowToken",
  name: "ADM_LEVELS.settings.levelsFollowToken.name",
  hint: "ADM_LEVELS.settings.levelsFollowToken.hint",
  settingScope: "client", // the view is each GM's personal business

  onInit() {
    // Second checkbox of the sub-module: show the floor panel together with walls on Alt+W.
    game.settings.register(MODULE_ID, S_PANEL_ALTW, {
      name: "ADM_LEVELS.settings.levelsPanelAltW.name",
      hint: "ADM_LEVELS.settings.levelsPanelAltW.hint",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
    });
  },

  onReady({ isEnabled }) {
    if (!game.modules.get(LEVELS_ID)?.active) return; // without the third-party Levels there is nothing to follow

    // A Levels floor recompute must not take the selected token's eyes away (see _keepTokenEyes).
    // Not gated by the checkbox: Levels' own close() does it too. Levels and wall-height stay untouched.
    try {
      const proto = CONFIG.Levels?.UI?.constructor?.prototype;
      if (globalThis.libWrapper?.register && typeof proto?.computeLevelsVisibility === "function") {
        libWrapper.register(
          MODULE_ID,
          "CONFIG.Levels.UI.constructor.prototype.computeLevelsVisibility",
          function (wrapped, ...args) {
            const result = wrapped(...args);
            try { _keepTokenEyes(); } catch (e) { console.warn("[adm-levels] keep token eye height", e); }
            return result;
          },
          "WRAPPER",
        );
      }
    } catch (e) { console.warn("[adm-levels] follow-token: eye height wrapper", e); }

    // The same eyes once a move of the selected token has finished animating. wall-height reads them on
    // updateToken, while v13 still gives the ANIMATED elevation — the starting one: up the stairs 0 → 15 the
    // eyes stayed at 0 and the door icons of floor 0 stayed on until the next update (23.09.2026, «Lilith
    // climbed from 0 to 15 and sees the doors of 0»). No animation — wall-height has read the final one itself.
    Hooks.on("updateToken", (doc, changes) => {
      if (!("x" in changes) && !("y" in changes) && !("elevation" in changes)) return;
      const token = doc?.object;
      if (!token?.controlled) return;
      const done = token.movementAnimationPromise;
      if (!done) return;
      done.then(() => {
        try { _keepTokenEyes(); } catch (e) { console.warn("[adm-levels] keep token eye height", e); }
      }, () => {});
    });

    // ── Floor panel on Alt+W ──────────────────────────────────────────────
    // The panel is hidden by default (Levels itself closes it on every canvasInit,
    // levels/scripts/ui.js:643) and is shown ONLY together with walls/regions
    // on Alt+W — the same switch as all the map "scaffolding".
    // The event is sent by _toggleWalls (main.mjs): we keep the feature here, not there.
    const _altWOk = () => {
      try { return game.user?.isGM && game.settings.get(MODULE_ID, S_PANEL_ALTW); }
      catch (_e) { return false; }
    };
    Hooks.on("admLevelsWallsToggled", (visible) => {
      if (!_altWOk()) return;
      const ui = CONFIG.Levels?.UI;
      if (!ui) return;
      if (visible) {
        // ⚠️ Do NOT force-show it where Levels is not in use: on a scene with no
        // declared floors the panel is useless, and opening it also writes
        // foregroundElevation into the scene (levels/scripts/ui.js:51).
        if (!_sceneHasLevels(canvas?.scene)) return;
        if (ui.rendered) return;
        // ⚠️ The panel calls canvas.tiles.activate() in activateListeners (ui.js:52) —
        // without compensation Alt+W throws the GM onto the tiles layer.
        // ⚠️ But we MUST restore THE SAME layer, not "tokens". The previous version hard-coded
        // activating tokens/select, and Alt+W dragged you off any layer: drawing walls
        // or regions — and you get kicked into actor mode. Take a snapshot BEFORE showing
        // the panel and restore it.
        const _ctrls = ui2Controls();
        const _prevControl = String(_ctrls?.control?.name ?? "") || null;
        const _prevTool = String(_ctrls?.tool?.name ?? "") || null;
        // What the floor view was before — to be brought back when Alt+W closes the window.
        _altWPanel = {
          wasOn: !!ui.rangeEnabled,
          range: Array.isArray(ui.range) ? [...ui.range] : null,
          changed: false,
        };
        try {
          ui.render(true);
          // Wait a frame: the activation inside the panel is async and would override ours.
          setTimeout(() => {
            try {
              if (!_prevControl) return;                 // the layer was unknown — leave it alone
              const c = ui2Controls();
              if (!c) return;
              // Already there (the panel overrode nothing) — do not poke it again.
              if (String(c.control?.name ?? "") === _prevControl) return;
              c.activate(_prevTool ? { control: _prevControl, tool: _prevTool } : { control: _prevControl });
            } catch (_e) {}
          }, 150);
        } catch (e) { console.warn("[adm-levels] show levels panel", e); }
      } else {
        if (!ui.rendered) return;
        // Close only the window Alt+W itself opened: one the GM opened by hand stays as it is.
        // ⚠️ Closing it drops Levels out of the floor view (rangeEnabled = false in ui.close()), and the
        // floor lives without the window too (_followElevation) — so it is put back: the floor picked
        // during Alt+W, otherwise the one from before (23.09.2026: «Alt+W breaks Levels — I was on
        // level 1, and after it as if Levels is not used»).
        const st = _altWPanel;
        _altWPanel = null;
        if (!st) return;
        const keep = st.changed
          ? (ui.rangeEnabled && Array.isArray(ui.range) ? [...ui.range] : null)
          : (st.wasOn ? st.range : null);
        // Close as if via the X button (no force): this way the panel saves edits to names and
        // ranges and restores visibility normally — the force path skips that.
        try { ui.close(); } catch (e) { console.warn("[adm-levels] hide levels panel", e); }
        if (keep) { try { _restoreFloor(keep); } catch (e) { console.warn("[adm-levels] restore floor", e); } }
      }
    });
    // A floor picked while the Alt+W window is open (a level click, a followed token) is kept on close.
    Hooks.on("levelsUiChangeLevel", () => { if (_altWPanel) _altWPanel.changed = true; });
    // The window was closed by hand (or by Levels on a scene change) — Alt+W has nothing to close.
    Hooks.on("closeLevelsUI", () => { _altWPanel = null; });

    // The floor panel is a GM thing; a player's perspective already follows their token.
    const _active = () => isEnabled() && game.user?.isGM && !!CONFIG.Levels?.UI;

    // Token selected → jump to its floor right away.
    Hooks.on("controlToken", (token, controlled) => {
      if (!controlled || !_active()) return;
      _followElevation(token?.document?.elevation);
    });

    // Elevation of the selected token changed (stairs, region, manual edit) → follow.
    // Gate on controlled: otherwise any NPC stepping along the first floor would yank the GM's view.
    Hooks.on("updateToken", (tokenDoc, changes) => {
      if (!("elevation" in (changes ?? {}))) return;
      if (!tokenDoc?.object?.controlled) return;
      if (!_active()) return;
      _followElevation(changes.elevation);
    });

    // Teleport (the system's teleport tag and portal auras): focus on the token is often lost
    // during a teleport, and both gates above stay silent — the panel stayed on the old
    // level (user: "teleported, but the level stayed at 1"). The teleport handler
    // (adm-text-hooks) sends the event ONLY on the initiator's client — we drive the panel
    // after the teleported token directly, regardless of selection.
    Hooks.on("admTokenTeleported", (tokenDoc) => {
      if (!_active()) return;
      _followElevation(tokenDoc?.elevation);
    });

    // A token dropped with a level picked landed on a floor of another level (main.mjs createToken: the stern's
    // deck 30 is drawn in the level 15–30 tile) — the panel goes to that floor, or the new token stays hidden
    // (24.09.2026). Any GM, regardless of this sub-module's checkbox: it is part of placing the token.
    Hooks.on("admTokenPlacedOnFloor", (tokenDoc) => {
      if (!game.user?.isGM || !CONFIG.Levels?.UI) return;
      _followElevation(tokenDoc?.elevation);
    });
  },
};
