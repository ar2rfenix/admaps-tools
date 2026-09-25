// scripts/tools/floor-range.mjs
// The floor the GM picked in the Levels panel, and which walls / regions stand on it.
// Shared by the map «scaffolding» (Alt+W, main.mjs), the door swing preview and «Walls by clicks»
// (23.09.2026: Alt+W showed every floor at once, and the wall magnet pulled to the walls below).
// A helper, not a sub-module: no TOOL here.

/** The Levels panel floor while the panel is on: { lo, hi } (a degenerate top = +∞);
 *  null — no floor picked (panel closed / no Levels): everything counts, as before. */
export function panelFloor() {
  const ui = CONFIG.Levels?.UI;
  if (!ui?.rangeEnabled || !Array.isArray(ui.range) || !ui.range.length) return null;
  const lo = parseFloat(ui.range[0]), hi = parseFloat(ui.range[1]);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return null;
  const l = Number.isFinite(lo) ? lo : -Infinity;
  return { lo: l, hi: Number.isFinite(hi) && hi > l ? hi : Infinity };
}

/** A height bound; unset (null / "" — how Foundry stores an empty field) is ±Infinity.
 *  Filter out «unset» BEFORE Number(): Number(null) is 0. */
function _bound(raw, inf) {
  if (raw === null || raw === undefined || raw === "") return inf;
  const n = Number(raw);
  return Number.isFinite(n) ? n : inf;
}

/** A span [b, t] meets the floor [lo, hi). Both ends exclusive, the «Wall height filter» rule: a
 *  thing ending exactly at the floor's bottom belongs to the floor below, one starting exactly at
 *  its top — to the floor above. A zero-height span (a surface) is a point: lo ≤ b < hi. */
function _meets(b, t, floor) {
  if (!floor) return true;
  if (t === b) return b >= floor.lo && b < floor.hi;
  return t > floor.lo && b < floor.hi;
}

/** A wall stands on the floor (wall-height flags; an empty height = full height, every floor). */
export function wallOnFloor(doc, floor) {
  if (!floor) return true;
  const f = doc?.flags?.["wall-height"] ?? {};
  return _meets(_bound(f.bottom, -Infinity), _bound(f.top, Infinity), floor);
}

/** A region stands on the floor (its own elevation; an open bound = every floor that way). */
export function regionOnFloor(doc, floor) {
  if (!floor) return true;
  return _meets(_bound(doc?.elevation?.bottom, -Infinity), _bound(doc?.elevation?.top, Infinity), floor);
}
