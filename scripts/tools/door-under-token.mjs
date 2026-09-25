// scripts/tools/door-under-token.mjs
// ADMaps Tools sub-module: «Door under a token does not toggle».
//
// PROBLEM. The door icon sits on top of the map and catches the click first. If a token
// stands in the doorway, it cannot be grabbed with the mouse: every click opens or
// closes the door. The only workaround is moving the door or the token — i.e. none.
//
// SOLUTION. While a visible token stands under the icon, the icon takes no part in
// click hit-testing (eventMode = "none"): the click passes through it to the token. Plus
// a safeguard on the door handler itself — if the click still got through, no toggle.
//
// The door stays visible and works as before once the token steps aside.

const MODULE_ID = "adm-levels";

// ⚠️ A door BETWEEN cells (on a grid line — that is how Dungeon Draw and ordinary
// grid-snapped walls draw it) does not get in the way of dragging a token: its icon lies
// on the cell border, not on top of the token. It must not be blocked — otherwise the door
// cannot be opened from any adjacent cell (previously the icon center was tested against
// the token rectangle INCLUSIVELY, and a point on the shared border "hit" both adjacent
// cells). Now we block only a door whose segment passes through the INTERIOR of the
// token's cell (with an EDGE_EPS px inset) — i.e. a door drawn across the cell the token stands on.
const EDGE_EPS = 3;

/** Does the door segment pass through the interior of the token rectangle (border does not count). */
function _doorCrossesToken(control, t) {
  const c = control?.wall?.document?.c;
  const x0 = Number(t.document.x) || 0, y0 = Number(t.document.y) || 0;
  const w = Number(t.w) || 0, h = Number(t.h) || 0;
  const rx0 = x0 + EDGE_EPS, ry0 = y0 + EDGE_EPS, rx1 = x0 + w - EDGE_EPS, ry1 = y0 + h - EDGE_EPS;
  if (rx1 <= rx0 || ry1 <= ry0) return false;
  const inside = (x, y) => x > rx0 && x < rx1 && y > ry0 && y < ry1;
  if (!Array.isArray(c) || c.length < 4) {
    // No wall (should not happen) — old icon-center criterion, but strictly inside.
    const p = control?.center ?? control;
    return inside(Number(p?.x), Number(p?.y));
  }
  const A = { x: c[0], y: c[1] }, B = { x: c[2], y: c[3] };
  if (inside(A.x, A.y) || inside(B.x, B.y)) return true;
  const corners = [{ x: rx0, y: ry0 }, { x: rx1, y: ry0 }, { x: rx1, y: ry1 }, { x: rx0, y: ry1 }];
  for (let i = 0; i < 4; i++) {
    if (foundry.utils.lineSegmentIntersects(A, B, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** Is a visible token standing on the door (inside its cell). */
function _tokenUnder(control) {
  try {
    // Wall heights: a token a floor above or below the door does not block it.
    const wh = control?.wall?.document?.flags?.["wall-height"] ?? {};
    const wTop = Number.isFinite(Number(wh.top)) ? Number(wh.top) : Infinity;
    const wBot = Number.isFinite(Number(wh.bottom)) ? Number(wh.bottom) : -Infinity;

    for (const t of (canvas?.tokens?.placeables ?? [])) {
      if (!t?.document) continue;
      if (!t.visible) continue;                       // an invisible token "is not there" — the door works
      // A dummy is decoration; it must not lock the door forever.
      if (t.document.actor?.type === "dummy") continue;
      const z = Number(t.document.elevation) || 0;
      if (z > wTop || z < wBot) continue;
      if (_doorCrossesToken(control, t)) return true;
    }
  } catch (_e) {}
  return false;
}

let _applying = false;

function _apply(isEnabled) {
  if (_applying) return;
  _applying = true;
  try {
    for (const ctrl of (canvas?.controls?.doors?.children ?? [])) {
      const block = isEnabled() && _tokenUnder(ctrl);
      if (block) {
        if (ctrl.eventMode !== "none") {
          ctrl.__admPrevEventMode = ctrl.__admPrevEventMode ?? ctrl.eventMode;
          ctrl.eventMode = "none";
        }
      } else if (ctrl.__admPrevEventMode != null) {
        ctrl.eventMode = ctrl.__admPrevEventMode;
        ctrl.__admPrevEventMode = null;
      }
    }
  } catch (e) { console.warn("[adm-levels] door under token:", e); }
  finally { _applying = false; }
}

export const TOOL = {
  id: "doorUnderToken",
  name: "ADM_LEVELS.settings.doorUnderToken.name",
  hint: "ADM_LEVELS.settings.doorUnderToken.hint",

  onReady({ isEnabled }) {
    const run = foundry.utils.debounce(() => _apply(isEnabled), 30);

    // Safeguard on the toggle itself: in case the click still reached the door
    // (another module restored its interactivity, a custom hotkey, etc.).
    try {
      if (globalThis.libWrapper?.register) {
        libWrapper.register(
          MODULE_ID,
          "CONFIG.Canvas.doorControlClass.prototype._onMouseDown",
          function (wrapped, ...args) {
            if (isEnabled() && _tokenUnder(this)) return false;
            return wrapped(...args);
          },
          "MIXED",
        );
      }
    } catch (e) { console.warn("[adm-levels] door under token: click wrapper", e); }

    Hooks.on("canvasReady", run);
    Hooks.on("refreshToken", run);
    Hooks.on("createToken", run);
    Hooks.on("deleteToken", run);
    Hooks.on("updateToken", run);
    Hooks.on("drawWall", run);
    Hooks.on("updateWall", run);
    Hooks.on("deleteWall", run);
    run();
  },
};
