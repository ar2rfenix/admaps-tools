// scripts/tools/levels-ghost-tokens.mjs
// ADMaps Tools sub-module: «Tokens on other floors as ghosts».
//
// PROBLEM. When the GM has no token selected, the third-party Levels HIDES everyone
// who is not on the current floor, and the GM loses the overview: a token flying
// above the map simply vanishes. It does so in two places (levels/scripts/handlers/uiHandler.js):
//   • UIVisible(placeable) — called from the refreshToken hook (wrappers.js:5-10)
//     and writes placeable.visible directly;
//   • tokenUIWrapperIsVisible — a libWrapper on Token#isVisible (wrappers.js:116).
// Both gates work ONLY for the GM, ONLY with rangeEnabled and ONLY when no token
// is selected — with a token selected Levels shows everything anyway.
//
// SOLUTION. In that same case, do not hide but fade via alpha: the GM sees the whole
// map yet instantly tells «own» floor from the others. Both gates have to be bypassed:
// one with our own libWrapper on top of theirs (ours registers later and wraps
// from the outside), the other with our own refreshToken hook, which also runs after theirs.

const LEVELS_ID = "levels";
const MODULE_ID = "adm-levels";
const S_ALPHA = "ghostTokensAlpha";     // separate setting of the sub-module
const ALPHA_DEFAULT = 50;               // opacity in percent

/** Ghost opacity, 0..1.
 *  The setting is stored in PERCENT — a slider at «50» reads clearer than «0.5». */
function _ghostAlpha() {
  try {
    const v = Number(game.settings.get(MODULE_ID, S_ALPHA));
    if (!Number.isFinite(v)) return ALPHA_DEFAULT / 100;
    return Math.min(1, Math.max(0, v / 100));
  } catch (_e) { return ALPHA_DEFAULT / 100; }
}

/** The token's own opacity multiplier — the way the core computes it.
 *  ⚠️ Not `|| 1`: `alpha = 0` is perfectly legal (the «Opacity» slider in the token
 *  window goes down to zero — that is how utility anchor tokens are made). With `|| 1`
 *  such a token, once ghosted, would on the contrary SHOW THROUGH, and the stronger
 *  the higher the setting. The field is required, so a non-number means «no document». */
function _docAlpha(token) {
  const d = Number(token?.document?.alpha);
  return Number.isFinite(d) ? d : 1;
}

/** Redraw the tokens so the new value takes effect immediately, without a reload.
 *  The render flag makes the core recompute the state and call `refreshToken`,
 *  and that is where we set the alpha. */
function _redrawTokens() {
  try {
    for (const t of (canvas?.tokens?.placeables ?? [])) t.renderFlags?.set({ refreshState: true });
  } catch (_e) {}
}

// The overlap test comes from the system — the same one that resolves zone and aura hits.
let _floorSeparates = null;
async function _loadFloorTest() {
  // Only on that system: elsewhere the file does not exist, and the failed import still logs a 404 in the console.
  // Called from onReady — at module load game.system is not known yet.
  if (globalThis.game?.system?.id !== "adm-daggerheart") return;
  try {
    const m = await import("/systems/adm-daggerheart/scripts/floor-planes.mjs");
    if (typeof m?.admFloorOrGroundSeparates === "function") _floorSeparates = m.admFloorOrGroundSeparates;
  } catch (_e) { /* different system — ghosts work as before */ }
}

/**
 * Is the token separated from the viewer by a SLAB (a floor or ceiling between them).
 *
 * ⚠️ Semi-transparency is useful only when we share ONE space at different
 * heights: a dragon flying above you should show through. But if there is decking
 * between you, the token must not be visible at all, or the ghost reads through the floor.
 */
function _floorApart(token) {
  try {
    if (!_floorSeparates || !token) return false;
    const eps = Math.min(1, (Number(canvas?.scene?.grid?.distance) || 5) / 10);
    const bz = (Number(token.document?.elevation) || 0) + eps;

    const ref = canvas?.tokens?.controlled?.[0] ?? CONFIG.Levels?.currentToken ?? null;
    if (ref) {
      if (ref.id === token.id) return false;
      const az = (Number(ref.document?.elevation) || 0) + eps;
      if (az === bz) return false;
      return !!_floorSeparates(ref.center, az, token.center, bz);
    }

    // ⚠️ NO token SELECTED — which is exactly the usual state of a GM looking at
    // a floor through the Levels panel. This used to bail out with «not separated», so
    // the rule failed in precisely the case it was made for. There is no viewer point,
    // so take the bottom of the SELECTED FLOOR and the same cell: is there decking between
    // that floor and the token directly above (or below) it.
    const ui = CONFIG.Levels?.UI;
    if (!ui?.rangeEnabled) return false;
    const r = ui.getRange?.();
    const b = parseFloat(r?.bottom);
    if (!Number.isFinite(b)) return false;
    const az = b + eps;
    if (az === bz) return false;
    const c = token.center;
    return !!_floorSeparates(c, az, c, bz);
  } catch (_e) { return false; }
}

/** The token is outside the panel's current floor — and Levels would hide it for that reason alone. */
function _isOffLevel(token) {
  if (!game.user?.isGM) return false;
  const ui = CONFIG.Levels?.UI;
  if (!ui?.rangeEnabled) return false;
  // A token is selected — Levels shows everything natively, nothing to intervene in.
  if (canvas?.tokens?.controlled?.length || CONFIG.Levels?.currentToken) return false;
  const r = ui.getRange?.();
  if (!r || !Number.isFinite(r.bottom) || !Number.isFinite(r.top)) return false;
  const h = Number(token?.losHeight ?? token?.document?.elevation);
  if (!Number.isFinite(h)) return false;
  return !(h >= r.bottom && h <= r.top);
}

export const TOOL = {
  id: "levelsGhostTokens",
  name: "ADM_LEVELS.settings.levelsGhostTokens.name",
  hint: "ADM_LEVELS.settings.levelsGhostTokens.hint",
  settingScope: "client", // how the GM looks at the map is their own business

  onInit() {
    game.settings.register(MODULE_ID, S_ALPHA, {
      name: "ADM_LEVELS.settings.ghostTokensAlpha.name",
      hint: "ADM_LEVELS.settings.ghostTokensAlpha.hint",
      scope: "client",
      config: true,
      type: Number,
      default: ALPHA_DEFAULT,
      range: { min: 5, max: 100, step: 5 },
      // ⚠️ The setting is CLIENT-SIDE: it lives in browser storage, creates no Setting
      // document, so there will be no updateSetting hook for it. Live application
      // is only possible from here.
      onChange: () => _redrawTokens(),
    });
  },

  onReady({ isEnabled }) {
    if (!game.modules.get(LEVELS_ID)?.active) return;

    _loadFloorTest();

    const _on = () => isEnabled() && game.user?.isGM;

    // ── Gate 1: Token#isVisible ───────────────────────────────────────────
    // Our WRAPPER registers LATER than the Levels one, so it wraps it from the
    // outside and sees the already computed result. We return true only when the
    // false came from the floor: the GM has almost no other reasons to hide a token
    // (hidden ones the GM sees semi-transparent anyway by core means).
    try {
      if (globalThis.libWrapper?.register) {
        libWrapper.register(
          MODULE_ID,
          "CONFIG.Token.objectClass.prototype.isVisible",
          function (wrapped, ...args) {
            const v = wrapped(...args);
            // Separated by a slab — hide, even if the core would show it.
            if (_on() && _floorApart(this)) return false;
            if (v) return true;
            if (!_on()) return v;
            return _isOffLevel(this) ? true : v;
          },
          "WRAPPER",
        );
      }
    } catch (e) { console.warn("[adm-levels] floor ghosts: isVisible wrapper failed", e); }

    // ── Gate 2: the refreshToken hook ─────────────────────────────────────
    // Levels writes placeable.visible directly in its refreshToken. Our hook is
    // registered later → runs afterwards, and our value stays.
    // The alpha is set right here too: refreshToken runs after the core has updated
    // the state, so the value holds until the next redraw, and there we set it
    // again.
    Hooks.on("refreshToken", (token) => {
      try {
        if (!_on()) { _restore(token); return; }
        // Decking between us — the token is not visible at all. A ghost is harmful
        // here: it reads through the floor and gives away what must not be seen.
        if (_floorApart(token)) {
          token.visible = false;
          _restore(token);              // we do not hold the alpha — visibility itself hides
          // ⚠️ Blocking clicks — ONLY here, where decking lies between us. «Another floor»
          // by itself is no reason: a creature in the open at a different height
          // is selectable as usual; that is what the regions were laid out for.
          if (token.eventMode !== "none") {
            token.__admPrevEventMode = token.__admPrevEventMode ?? token.eventMode;
            token.eventMode = "none";
          }
          return;
        }
        // Not separated — restore the ability to catch clicks, if we took it away.
        if (token.__admPrevEventMode != null) {
          token.eventMode = token.__admPrevEventMode;
          token.__admPrevEventMode = null;
        }
        if (_isOffLevel(token)) {
          token.visible = true;
          // ⚠️ The container alpha alone is NOT enough: since v10 the token sprite lives
          // in the primary canvas group, not among the object's children, and the core
          // computes mesh.alpha = this.alpha * document.alpha in _refreshState/_refreshMesh —
          // i.e. BEFORE our hook. Our value would reach the picture only on the
          // next redraw, and that one overwrites it right away. So we set
          // both: the container (border, bars, name) and the sprite itself.
          const a = _ghostAlpha();
          token.alpha = a;
          if (token.mesh) token.mesh.alpha = a * _docAlpha(token);
          token.__admGhosted = true;
        } else {
          _restore(token);
        }
      } catch (_e) { /* one token must not take down the layer redraw */ }
    });

    /** Restore the opacity if it was us who faded it. Someone else's alpha is left alone.
     *  Recompute exactly like the core (_refreshState) rather than setting one: the
     *  token may have its own opacity in the document, or be hidden. */
    function _restore(token) {
      if (!token?.__admGhosted) return;
      token.__admGhosted = false;
      // Restore the ability to catch clicks.
      try {
        if (token.__admPrevEventMode != null) {
          token.eventMode = token.__admPrevEventMode;
          token.__admPrevEventMode = null;
        }
      } catch (_e) {}
      try {
        const base = Number(token._getTargetAlpha?.());
        token.alpha = Number.isFinite(base) ? base : 1;
        if (token.mesh) token.mesh.alpha = token.alpha * _docAlpha(token);
      } catch (_e) {
        // Computing failed — do not invent a one (it would reveal a token whose
        // owner set zero opacity); ask the core to recompute the state itself instead.
        try { token.renderFlags?.set({ refreshState: true }); } catch (_e2) {}
      }
    }
  },
};
