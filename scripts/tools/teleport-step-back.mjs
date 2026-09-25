// scripts/tools/teleport-step-back.mjs
// ADMaps Tools sub-module: «Teleport: step back on refusal».
//
// PROBLEM. A token walks into a region with a «Teleport Token» behavior. Core splits the path at the exact
// point where the token's CENTER crosses the region edge (documents/token.mjs #splitMovementPath: a checkpoint
// with snapped:false), commits the part up to it and fires TOKEN_MOVE_IN; the behavior stops the rest of the
// movement (token.stopMovement) and asks. Answer «No» or close the dialog — and the token stays right there:
// off the grid, half inside the portal, its center exactly on the region edge. When that edge runs along a
// wall, the token stands IN the wall and cannot walk out (23.09.2026, Modular_Ship_Pack: Ivy stopped at
// 1396,962 — center on the lower edge of t2, which is the 30–40 wall of the mast platform).
// The jump itself is not the problem: core teleports with the «displace» action, walls do not apply to it.
//
// SOLUTION. When the teleport did not happen, return the token to the last point of its path BEFORE the
// region, snapped to the grid, with «displace» as well: through walls, at no movement cost, and without
// a new trigger (the behavior ignores a displace arrival). An accepted teleport is left alone.
//
// ⚠️ The handler is a private static of the behavior class, but the region calls it through the PUBLIC
// `events` table (documents/region-behavior.mjs: system.constructor.events[name].call(system, event)),
// read on every call — so replacing the entry there wraps it.

const TYPE = "teleportToken";

/** The last path point outside the region — snapped, if the snapped cell is outside too. */
function _stepBackTarget(token, region, movement) {
  const src = token._source;
  const size = { width: src.width, height: src.height, shape: src.shape };
  const passed = movement?.passed?.waypoints ?? [];
  const candidates = [...passed.slice(0, -1).reverse(), movement?.origin].filter(Boolean);
  for (const c of candidates) {
    const p = { x: Math.round(c.x), y: Math.round(c.y), elevation: Number(c.elevation) || 0, ...size };
    if (token.testInsideRegion(region, p)) continue;
    const s = token.getSnappedPosition(p);
    const snapped = { ...p, x: Math.round(s.x), y: Math.round(s.y) };
    return token.testInsideRegion(region, snapped) ? p : snapped;
  }
  return null;
}

async function _stepBack(token, region, movement, stop) {
  // Teleported, deleted or taken to another scene — nothing to do.
  if (!token.parent?.tokens?.has(token.id) || (region?.parent !== token.parent)) return;
  const src = token._source;
  // Only x/y: the elevation may have been corrected after the stop (elevation magnet).
  if ((src.x !== Math.round(stop.x)) || (src.y !== Math.round(stop.y))) return;
  // Stopped exactly on a cell — an ordinary spot, leave it.
  const s = token.getSnappedPosition(src);
  if ((Math.round(s.x) === src.x) && (Math.round(s.y) === src.y)) return;
  const target = _stepBackTarget(token, region, movement);
  if (!target) return;
  await token.move({ x: target.x, y: target.y, elevation: target.elevation, action: "displace" });
}

export const TOOL = {
  id: "teleportStepBack",
  name: "ADM_LEVELS.settings.teleportStepBack.name",
  hint: "ADM_LEVELS.settings.teleportStepBack.hint",

  onReady({ isEnabled }) {
    const cls = CONFIG.RegionBehavior?.dataModels?.[TYPE];
    const E = CONST.REGION_EVENTS?.TOKEN_MOVE_IN;
    const orig = cls?.events?.[E];
    if ((typeof orig !== "function") || orig.__admStepBack) return;

    const wrapped = async function (event) {
      const token = event?.data?.token;
      const movement = event?.data?.movement;
      const stop = movement?.passed?.waypoints?.at(-1);
      // Exactly the cases in which core stops the token: on the mover's own client, with a live destination,
      // after a walked (not displaced) entry.
      let armed = false;
      try {
        armed = isEnabled() && !!event?.user?.isSelf && !!token && !!stop && (stop.action !== "displace")
          && (fromUuidSync(this.destination) instanceof foundry.documents.RegionDocument);
      } catch (_e) { armed = false; }
      try {
        return await orig.call(this, event);
      } finally {
        if (armed) {
          try { await _stepBack(token, event.region, movement, stop); }
          catch (e) { console.warn("[adm-levels] teleport step back", e); }
        }
      }
    };
    wrapped.__admStepBack = true;
    cls.events[E] = wrapped;
  },
};
