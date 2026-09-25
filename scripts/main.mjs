/**
 * ADMaps DH Levels — Region-based elevation for Daggerheart.
 * Plateau: flat elevation. Stairs: ramp interpolated by position + direction.
 *
 * ADMaps Tools: a container of sub-modules. Internal features live in scripts/tools/ (one file
 * per sub-module), each with a settings checkbox (default ON). See tools/index.mjs.
 */

import { initTools, registerToolSettings, startTools, handleSupersededModules, installSettingsHintTooltips } from "./tools/index.mjs";
import { panelFloor, wallOnFloor, regionOnFloor } from "./tools/floor-range.mjs";

// Build marker: `__ADM_BUILD` in the console shows which code the client actually
// loaded. Electron caches JS until a full re-login, and without the marker "not
// fixed" is indistinguishable from "not reloaded".
globalThis.__ADM_BUILD = Object.assign(globalThis.__ADM_BUILD ?? {}, { admLevels: "2026-09-25-1047" });

// Force fly.walls = "move" and swim.canSelect = true ASAP, before Foundry freezes CONFIG.
// By default in v13 swim has canSelect=false, so tokenDoc.update({movementAction:"swim"})
// silently falls back to null (persisted as null → after F5 default = walk).
const _admSwimCanSelect = () => true;
const _admPatchActions = (actions) => {
  const out = {};
  for (const [k, v] of Object.entries(actions)) {
    if (k === "fly") out[k] = { ...v, walls: "move" };
    else if (k === "swim") out[k] = { ...v, canSelect: _admSwimCanSelect, walls: "move" };
    else out[k] = v;
  }
  return out;
};
try {
  const fly = CONFIG?.Token?.movement?.actions?.fly;
  const swim = CONFIG?.Token?.movement?.actions?.swim;
  if (fly && (Object.isFrozen(fly) || (swim && Object.isFrozen(swim)))) {
    // Frozen — replace entire actions object with unfrozen clone.
    Object.defineProperty(CONFIG.Token.movement, "actions", {
      value: _admPatchActions(CONFIG.Token.movement.actions),
      writable: true, configurable: true
    });
  } else {
    if (fly) fly.walls = "move";
    if (swim) { swim.canSelect = _admSwimCanSelect; swim.walls = "move"; }
  }
} catch (e) {
  // Fallback: try again at init when CONFIG might not be frozen yet.
  Hooks.once("init", () => {
    try {
      const actions = CONFIG?.Token?.movement?.actions;
      if (!actions) return;
      if (Object.isFrozen(actions.fly) || Object.isFrozen(actions.swim)) {
        Object.defineProperty(CONFIG.Token.movement, "actions", {
          value: _admPatchActions(actions),
          writable: true, configurable: true
        });
      } else {
        if (actions.fly) actions.fly.walls = "move";
        if (actions.swim) { actions.swim.canSelect = _admSwimCanSelect; actions.swim.walls = "move"; }
      }
    } catch (_e) { console.warn("[ADM:LEVELS] Cannot override actions:", _e.message); }
  });
}

const MODULE_ID = "adm-levels";
const FLAG_TYPE = "type";           // "plateau" | "stairs" | "water" | "transport"
const FLAG_ELEVATION = "elevation"; // signed key: "close", "-close", "medium", "-medium", etc.
const FLAG_FLOOR = "floor";         // stairs lower signed key
const FLAG_DIRECTION = "direction"; // 0-359 degrees
const FLAG_TRANSITION = "transition"; // compat: true for stairs regions (used by distance.mjs)
const FLAG_DISABLED = "disabled";    // boolean — whether the region is disabled (logic ignores it)
const FLAG_TILE_BIND = "tileBindId"; // string — id of the tile whose visibility the region is bound to
const FLAG_TILE_INVERT = "tileInvert"; // boolean — inverted logic (hidden→active, visible→inactive)
const FLAG_IGNORE_EFFECTS = "ignoreEffects"; // transport: a token inside ignores region effects (does not sink in water, auras do not apply)
const FLAG_VIDEO_SKIP = "videoSkip";   // string "N" | "N-M": pause of N (or random N..M) playbacks between showings of a video tile
const FLAG_VIDEO_POOL = "videoPool";   // string: wildcard pattern (e.g. "critters/birds-*.webm") — a random clip from the pool on each showing

/* ─────────────────────────────────────────────────────────────────────────
 * INTERNAL SUB-MODULES (ADMaps Tools). Each one is a separate file in scripts/tools/,
 * with a settings checkbox in the module settings (usually scope world and default ON;
 * a descriptor may set settingScope:"client"/defaultEnabled:false — as with
 * "ADMaps Cinema"). The registry is tools/index.mjs. Adding a sub-module = create
 * a file + add it to the TOOLS array there.
 * ───────────────────────────────────────────────────────────────────────── */
Hooks.once("init", () => { initTools(); registerToolSettings(); installSettingsHintTooltips(); });

/* ───────────────────────── Elevation regions master switch ─────────────────────────
 * Plateaus / stairs / water / transport are the CORE of the module, not a sub-module, so
 * they had no checkbox of their own: module enabled — region elevation enabled. That got
 * in the way of anyone who only needs the other features (roofs, tiles, scenes).
 *
 * A WORLD setting, not client: elevation is shared geometry. If it diverged between GM
 * and player we would get "I see him, he doesn't see me" and mismatched movement paths.
 *
 * ⚠️ Data is NOT touched. Elevation is stored on the token: when disabled everyone stays
 * where they stood, they just stop snapping; enable it again — they snap again.
 * Region flags stay intact too, so the toggle is reversible in both directions. */
const SETTING_REGIONS = "regionElevation";
Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, SETTING_REGIONS, {
      name: "ADM_LEVELS.settings.regionElevation.name",
      hint: "ADM_LEVELS.settings.regionElevation.hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
      onChange: (value) => { _regionsOnCache = (value !== false); },
    });
  } catch (e) { console.warn("[ADM:LEVELS] failed to register the regions setting:", e); }
});

/** Whether elevation regions are enabled. Before the setting is registered (early code) — YES:
 *  the previous default behavior, and nothing breaks at startup.
 *  Cached after the first successful read (kept current by the setting's onChange): every floor query asks it, and
 *  reading a world setting is a linear search through all of the world's settings (433 here) — thousands of reads
 *  per path search (24.09.2026). */
let _regionsOnCache = null;
function _regionsOn() {
  if (_regionsOnCache !== null) return _regionsOnCache;
  try { return (_regionsOnCache = (game.settings.get(MODULE_ID, SETTING_REGIONS) !== false)); }
  catch { return true; }
}

/** Can the point be inside the region at all? A box test against the region's bounds padded by 1 px: the core's
 *  bounds (every shape kind, holes cut out) together with the raw shapes' box — the fallback ray-cast in
 *  _elevationAtXY reads raw shapes, holes and unrotated rectangles included, and the edge tests allow 0.5 px.
 *  Floor queries scan every region for every point, and each region paid its flag reads and tests in full — the
 *  pathfinder makes thousands of such queries (24.09.2026). The box is dropped on any update of the region. */
const _regionBoxCache = new WeakMap();
Hooks.on("updateRegion", (doc) => { _regionBoxCache.delete(doc); });
function _regionBoxHas(region, px, py) {
  const doc = region.document;
  let box = _regionBoxCache.get(doc);
  if (box === undefined) {
    box = null;
    try {
      const b = doc.bounds;
      let minX = b.x, minY = b.y, maxX = b.x + b.width, maxY = b.y + b.height;
      const raw = _regionBounds(region);
      if (raw) {
        minX = Math.min(minX, raw.minX); minY = Math.min(minY, raw.minY);
        maxX = Math.max(maxX, raw.maxX); maxY = Math.max(maxY, raw.maxY);
      }
      if ([minX, minY, maxX, maxY].every(Number.isFinite)) box = { minX: minX - 1, minY: minY - 1, maxX: maxX + 1, maxY: maxY + 1 };
    } catch { box = null; }
    _regionBoxCache.set(doc, box);
  }
  if (!box) return true; // no box — test the region in full, as before
  return (px >= box.minX) && (px <= box.maxX) && (py >= box.minY) && (py <= box.maxY);
}
// Sub-module hooks are registered on "setup" — BEFORE the UI renders (the controls panel + scene context
// menu are built between setup and ready). Otherwise getSceneControlButtons / getSceneContextOptions
// fire earlier and the freeze button / flip/variations menu items do not appear. The old standalone modules
// attached hooks at module-eval (even earlier) — that is why everything showed up for them. Registering hooks
// does not need the canvas; the callbacks themselves (canvasReady etc.) fire later on their own.
Hooks.once("setup", () => startTools());
// Disabling the old modules + a possible reload dialog — on ready, in the background (does not block sub-modules).
Hooks.once("ready", () => {
  Promise.resolve().then(() => handleSupersededModules()).catch((e) => console.warn("[ADM:Tools] superseded:", e));
});

/** Pick mode: wait for a click on the canvas, find the topmost tile under the cursor.
 *  Returns a TileDocument or null (Esc / click outside a tile). */
async function _pickTileOnCanvas() {
  return new Promise((resolve) => {
    let resolved = false;
    const onPointerDown = (event) => {
      if (resolved) return;
      let pos;
      try {
        const ge = event.data?.global ?? event.global ?? null;
        pos = ge ? canvas.stage.toLocal(ge) : null;
      } catch (_) {}
      if (!pos) {
        // fallback — current mouse position
        pos = canvas.app?.renderer?.events?.pointer ?? null;
        if (pos) pos = canvas.stage.toLocal(pos);
      }
      if (!pos) return;
      const tiles = canvas.tiles?.placeables ?? [];
      // Descending by sort — top to bottom.
      const sorted = [...tiles].sort((a, b) => (b.document?.sort ?? 0) - (a.document?.sort ?? 0));
      for (const t of sorted) {
        const d = t.document;
        if (!d) continue;
        if (pos.x >= d.x && pos.x <= d.x + d.width &&
            pos.y >= d.y && pos.y <= d.y + d.height) {
          resolved = true;
          _cleanup();
          // event is available — stop further handling (so the tile is not selected / token not targeted).
          try { event?.stopPropagation?.(); event?.preventDefault?.(); } catch (_) {}
          resolve(d);
          return;
        }
      }
      // Missed click — do nothing, wait for the next click.
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !resolved) {
        resolved = true;
        _cleanup();
        resolve(null);
      }
    };
    function _cleanup() {
      try { canvas.app.stage.off("pointerdown", onPointerDown); } catch (_) {}
      document.removeEventListener("keydown", onKeyDown, true);
    }
    canvas.app.stage.on("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

/** Whether the region is effectively disabled — combines the manual flag and the tile binding. */
function _isRegionEffectivelyDisabled(doc) {
  if (doc.getFlag(MODULE_ID, FLAG_DISABLED)) return true;
  const tileId = doc.getFlag(MODULE_ID, FLAG_TILE_BIND);
  if (!tileId) return false;
  const scene = doc.parent ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  if (!tile) return false; // tile deleted — the binding does not work, do not block
  const tileHidden = !!tile.hidden;
  const invert = !!doc.getFlag(MODULE_ID, FLAG_TILE_INVERT);
  // Default: tile visible → region active; tile hidden → disabled.
  // Inverted: tile hidden → region active; tile visible → disabled.
  const shouldBeActive = invert ? tileHidden : !tileHidden;
  return !shouldBeActive;
}

/** Is the token inside an active "transport" region with the "Ignore region effects" checkbox?
 *  Such a token does not sink in water and does not receive region auras (the "wagon" shield).
 *  Foundry computes region membership with the region's elevation bounds in mind —
 *  give transport regions an elevation range so a token flying above is not counted as inside. */
// The floor UNDER the token for transport logic: land (plateau/ground, transport+water skipped)
// OR, if there is no land — the water surface (transport floats on it). Nothing at all → 0.
// Shared by _ignoresRegionEffects (immunity "on the floor") and the carry snapshot (who we carry).
function _surfaceFloorAt(cx, cy, elev) {
  const land = _elevationAtXY(cx, cy, elev);
  return (land != null) ? land : (_waterSurfaceAtXY(cx, cy) ?? 0);
}
// For other modules (e.g. splatter): the surface UNDER a point (land OR water surface) —
// blood/effects land on it so a token on that surface (incl. on water at −15) can see them.
globalThis.__admSurfaceFloorAt = (px, py, elev) => { try { return _surfaceFloorAt(px, py, Number(elev) || 0); } catch { return 0; } };

/** The stairs region holding the point at elevation `z` (as the pathfinder sees the level), or null. */
function _rampAt(px, py, z) {
  if (!_regionsOn()) return null;
  for (const region of canvas.regions?.placeables ?? []) {
    if (!_regionBoxHas(region, px, py)) continue;
    const doc = region.document;
    if (doc.getFlag(MODULE_ID, FLAG_TYPE) !== "stairs" || _isRegionEffectivelyDisabled(doc)) continue;
    if (doc.testPoint({ x: px, y: py, elevation: z })) return region;
  }
  return null;
}
// For the pathfinder (routinglib, «by the terrain» graph): is a step between two cell centres a walk on or off a
// ramp through its SIDE (or cut across its corner)? The graph checked only walls at the start cell's height, so a
// route went half way up the stairs out of the hold and stepped off sideways — down 10 ft into the hold, or into a
// pocket between walls it could never be walked into (24.09.2026). Stairs are taken only along their slope, through
// their ends; a sideways step stays allowed where the floor on both sides is level. The same between two stairs:
// off the hold stairs at −5 across onto the high end (15) of the stairs next to them (24.09.2026).
// `za`/`zb` — the floors at A and B when known (the layered search); without `zb` both come from `za`.
globalThis.__admRampStepBlocked = (ax, ay, bx, by, za, zb) => {
  try {
    const zA = Number(za) || 0;
    const zB = (zb == null) ? zA : (Number(zb) || 0);
    const ra = _rampAt(ax, ay, zA), rb = _rampAt(bx, by, zB);
    if (ra === rb) return false;        // both off the stairs, or along the same stairs
    const gs = Number(canvas.grid?.size) || 100;
    const across = (r) => {             // the step's part across that stairs' slope
      const { dx, dy } = _rampDir(r.document);
      return Math.abs(((bx - ax) * -dy) + ((by - ay) * dx));
    };
    if (![ra, rb].some((r) => r && (across(r) >= gs / 2))) return false; // straight along: through the ends
    const sa = _surfaceFloorAt(ax, ay, zA);
    const sb = (zb == null) ? _surfaceFloorAt(bx, by, zA) : zB;
    return Math.abs(sb - sa) > 1;
  } catch { return false; }
};

// For the layered pathfinder (routinglib, cells × floors): the floor a WALKER stands on at B after walking straight
// from A (cell centres) off floor `za` — exactly as the elevation magnet will place it: carried through a ramp on
// the way (_walkArrival), then the region under B looked up from that level; no land — the water surface, or the
// ground. A route is only as good as the floors the real move will give it.
globalThis.__admStepFloor = (ax, ay, bx, by, za) => {
  try {
    const gs = Number(canvas.grid?.size) || 100;
    const arrive = _walkArrival(ax, ay, bx, by, Number(za) || 0, gs);
    const land = _elevationAtXY(bx, by, arrive);
    if (land != null) return land;
    const surf = _waterSurfaceAtXY(bx, by);
    if (surf != null) return Math.min(arrive, surf);
    return _wasInElevationRegion(arrive) ? 0 : arrive;
  } catch { return Number(za) || 0; }
};

/** Is the tile dissolved at the point right now — whole (a token under it, a linked roof hovered), inside a partial
 *  roof's hover cut, or hover-dissolved where a viewer sees (the core's vision channel)? Such a roof is not what the
 *  viewer means: through the stern castle's door Lilith was led into the room at 0, and the dissolved roof above it
 *  (15) became the goal — the route went up the stairs instead of through the door (24.09.2026). */
function _tileDissolvedAt(tile, px, py) {
  const st = tile?.mesh?._occlusionState;
  if (!st) return false;
  if ((Number(st.fade) || 0) > 0.5) return true;
  if (!((Number(st.vision) || 0) > 0.5)) return false;
  const cut = globalThis.__admPartialFadeCutAt?.(tile.id, px, py);
  if ((cut !== undefined) && (cut !== null)) return cut;
  for (const src of canvas.effects?.visionSources ?? []) {
    if (src?.active && src.los?.contains?.(px, py)) return true;
  }
  return false;
}

// For the layered pathfinder: the floor the viewer means at a point — the topmost VISIBLE Levels floor tile over it
// (Levels decides what shows: from the deck the stern castle's top is a roof in plain view, from the hold the deck
// above is hidden), taken as the region floor standing within that tile's range (the deck picture lies at −5, its
// floor region at 0; masts and ladders are «floors» for Levels with no walkable region in their range — skipped).
// Null — nothing meant, any floor at the point will do. Lilith was led to the castle top (15), and the flat graph
// took her down the hold stairs instead (24.09.2026). `fromZ` — the walker's elevation (see the level rule below).
globalThis.__admGoalFloor = (px, py, fromZ) => {
  try {
    const p = { x: px, y: py };
    const tiles = (canvas.tiles?.placeables ?? []).filter((t) => {
      const lv = t.document?.flags?.levels;
      return lv && (lv.rangeTop != null) && t.visible && t.mesh?.visible && t.mesh.containsCanvasPoint?.(p, 0.5)
        && !_tileDissolvedAt(t, px, py);
    }).sort((a, b) => (Number(b.document.elevation) || 0) - (Number(a.document.elevation) || 0));
    // The level the walker stands on comes first: when the topmost picture at the point belongs to it, the goal is a
    // floor of that level. Ivy on the stern stairs at 25 (level 15..30) pointed past the stairs' foot: the castle top
    // (15) lies there under the round mast platform (a mast picture 25..30, the platform walkable at 30) — the goal
    // took the platform and the route went round to the mast instead of down the stairs (24.09.2026). A picture of
    // another level keeps the rule below: from the deck (0) the castle top (15), from the stern top (30) the yard (30).
    const lvl = (fromZ == null) ? null : _sceneLevelAt(Number(fromZ));
    if (lvl && tiles.length) {
      const e0 = Number(tiles[0].document.elevation) || 0;
      if ((e0 >= lvl.bottom) && (e0 < lvl.top)) {
        for (const t of tiles) {
          const land = _tileFloorAt(t, px, py, (z) => (z >= lvl.bottom) && (z < lvl.top));
          if (land != null) return land;
        }
      }
    }
    for (const t of tiles) {
      const land = _tileFloorAt(t, px, py);
      if (land != null) return land;
    }
    return null;
  } catch { return null; }
};

/** The Levels scene level holding elevation `z` as { bottom, top } (top exclusive), or null (no levels here). */
function _sceneLevelAt(z) {
  const list = canvas.scene?.flags?.levels?.sceneLevels;
  if (!Array.isArray(list) || !Number.isFinite(z)) return null;
  for (const l of list) {
    const bottom = parseFloat(l?.[0]), top = parseFloat(l?.[1]);
    if (Number.isFinite(bottom) && Number.isFinite(top) && (z >= bottom) && (z < top)) return { bottom, top };
  }
  return null;
}

/** The walkable floor a Levels floor tile draws at a point, passing `ok` — the region floor standing within the
 *  tile's range; null — none (see __admGoalFloor). */
function _tileFloorAt(t, px, py, ok = () => true) {
  const lo = Number(t.document.elevation) || 0;
  const hi = Number(t.document.flags.levels.rangeTop);
  const top = Number.isFinite(hi) && (hi > lo) ? hi : lo + 0.01;
  for (const z of [lo, (lo + top) / 2, top - 0.01]) {
    const land = _elevationAtXY(px, py, z);
    if ((land != null) && (land >= lo - 0.5) && (land < top) && ok(land)) return land;
  }
  // A floor tile above the ground whose walkable surface stands ON its top or a step above its picture: a mast
  // yard at 30 over the mast picture 25..30 (or 29..29), the stern's deck 30 in the level tile 15..30. Nothing
  // walkable inside the range (the air under the yard) — the goal fell through to the deck picture below, and a walk
  // along the yard was led down and around (24.09.2026). Only above the ground: a room tile 0..15 must not take the
  // roof standing on its top for the room.
  if (lo > 0) {
    const cap = Math.max(top, lo + _cellFt());
    for (const z of [top, cap]) {
      const land = _elevationAtXY(px, py, z);
      if ((land != null) && (land >= lo - 0.5) && (land <= cap) && ok(land)) return land;
    }
  }
  return null;
}
// Same + a "the surface is water" flag (for splatter: blood on water is blurred/semi-transparent).
globalThis.__admSurfaceInfoAt = (px, py, elev) => {
  try {
    const e = Number(elev) || 0;
    const land = _elevationAtXY(px, py, e);
    if (land != null) return { elevation: land, isWater: false };
    const ws = _waterSurfaceAtXY(px, py);
    if (ws != null) return { elevation: ws, isWater: true };
    return { elevation: 0, isWater: false };
  } catch { return { elevation: 0, isWater: false }; }
};

function _ignoresRegionEffects(tokenDoc) {
  if (!tokenDoc) return false;
  // The system's "episode" NPC type is a hidden marker (through walls, GM-only HUD): region effects
  // (water/swimming, drowning, auras) do NOT apply to it, regardless of transport.
  const _a = tokenDoc.actor;
  if (_a?.type === "npc" && _a?.system?.npcType === "episode") return true;
  const gs = Number(canvas?.grid?.size) || 100;
  const tw = (Number(tokenDoc.width ?? 1) || 1) * gs, th = (Number(tokenDoc.height ?? 1) || 1) * gs;
  // _source — RAW committed values (no animation interpolation). Without this, when stepping down
  // onto a boat tokenDoc.elevation gives an intermediate value → floor check falsely "above floor" → swim → sank.
  const cx = (tokenDoc._source?.x ?? tokenDoc.x ?? 0) + tw / 2, cy = (tokenDoc._source?.y ?? tokenDoc.y ?? 0) + th / 2;
  const elev = Number(tokenDoc._source?.elevation ?? tokenDoc.elevation ?? 0) || 0;
  // Membership is computed with OUR OWN point-in-shape against transport region shapes:
  //  - NOT tokenDoc.regions (lags after an elevation change → sank until you exit/enter);
  //  - NOT region.testPoint (deprecated, tied to the region's elevation bounds → falsely false on a boat).
  // Elevation is handled by the floor check below (flying/climbing ABOVE the surface beneath — not immune).
  let onTransport = false;
  for (const rObj of (canvas?.regions?.placeables ?? [])) {
    const rDoc = rObj.document ?? rObj;
    if (rDoc.getFlag?.(MODULE_ID, FLAG_TYPE) !== "transport") continue;
    if (!rDoc.getFlag?.(MODULE_ID, FLAG_IGNORE_EFFECTS)) continue;
    if (_isRegionEffectivelyDisabled(rDoc)) continue;
    const shapes = rDoc._source?.shapes ?? rDoc.shapes;
    if (Array.isArray(shapes) && shapes.some((sh) => _pointInShape(sh, cx, cy))) { onTransport = true; break; }
  }
  if (!onTransport) return false;
  // Immunity only when the token is actually ON the transport floor, not flying/climbing ABOVE the surface beneath it.
  const floor = _surfaceFloorAt(cx, cy, elev);
  return elev <= floor + 0.5;
}
// For the system/other modules (e.g. region-aura.mjs checks aura immunity).
globalThis.__admIgnoresRegionEffects = (td) => { try { return _ignoresRegionEffects(td); } catch { return false; } };

// ── DEBUG ── detailed breakdown of a token's transport immunity (for logs/manual inspection in F12).
function _transportDbgInfo(tokenDoc) {
  try {
    const gs = Number(canvas?.grid?.size) || 100;
    const tw = (Number(tokenDoc.width ?? 1) || 1) * gs, th = (Number(tokenDoc.height ?? 1) || 1) * gs;
    const cx = (tokenDoc._source?.x ?? tokenDoc.x ?? 0) + tw / 2, cy = (tokenDoc._source?.y ?? tokenDoc.y ?? 0) + th / 2;
    const elev = Number(tokenDoc._source?.elevation ?? tokenDoc.elevation ?? 0) || 0;
    let matched = null, transportRegions = 0, transportActive = 0;
    for (const rObj of (canvas?.regions?.placeables ?? [])) {
      const rDoc = rObj.document ?? rObj;
      if (rDoc.getFlag?.(MODULE_ID, FLAG_TYPE) !== "transport") continue;
      transportRegions++;
      if (!rDoc.getFlag?.(MODULE_ID, FLAG_IGNORE_EFFECTS)) continue;
      if (_isRegionEffectivelyDisabled(rDoc)) continue;
      transportActive++;
      const shapes = rDoc._source?.shapes ?? rDoc.shapes;
      const inside = Array.isArray(shapes) && shapes.some((sh) => _pointInShape(sh, cx, cy));
      if (inside && !matched) matched = rDoc.id;
    }
    const floor = _surfaceFloorAt(cx, cy, elev);
    const immune = !!matched && elev <= floor + 0.5;
    return { name: tokenDoc.name, cx: Math.round(cx), cy: Math.round(cy), elev, movAct: String(tokenDoc.movementAction ?? "walk"),
             inWaterFlag: !!tokenDoc.getFlag?.(MODULE_ID, TFLAG_IN_WATER), transportRegions, transportActive, matchedRegion: matched, floor, immune,
             waterAtXY: !!_waterAtXY(cx, cy, elev) };
  } catch (e) { return { error: String(e) }; }
}
// In F12: select a token and call __admTransportDbg(_token)  OR  __admTransportDbg(canvas.tokens.controlled[0])
globalThis.__admTransportDbg = (t) => { const td = t?.document ?? t; const info = _transportDbgInfo(td); console.log("[ADM-TR-DBG] inspect", info); return info; };

// ── Free movement by transport ──
// Wrapper for TokenDocument#_shouldRecordMovementHistory: if the global __admFreeMovement (>0) is set, do NOT
// record movement history → the animated carry of passengers by transport does not spend movement in combat
// (the budget is computed from movementHistory). The flag is set only during the carry update (GM client); the
// rest of the time the original is called. Animation (animate:true) is independent of history recording.
Hooks.once("ready", () => {
  try {
    const TD = CONFIG?.Token?.documentClass ?? foundry?.documents?.TokenDocument;
    const proto = TD?.prototype;
    if (proto && typeof proto._shouldRecordMovementHistory === "function" && !proto.__admFreeMoveWrapped) {
      const orig = proto._shouldRecordMovementHistory;
      proto._shouldRecordMovementHistory = function (...a) {
        if ((Number(globalThis.__admFreeMovement) || 0) > 0) return false; // transport carry: free
        return orig.apply(this, a);
      };
      proto.__admFreeMoveWrapped = true;
    }
  } catch (e) { console.warn("[adm-levels] wrap _shouldRecordMovementHistory", e); }
});

/* ------------------------------------------------------------------ *
 *  "Transport" CARRIES tokens: when a transport region moves/rotates
 *  (e.g. a Mass Edit link with a wagon tile changes region.shapes) —
 *  move the tokens INSIDE it with the same rigid transform (shift + rotation).
 *  You link only the region; any NPC on the wagon rides automatically.
 * ------------------------------------------------------------------ */
function _shapeCenter(s) {
  if (Array.isArray(s?.points) && s.points.length >= 2) {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < s.points.length; i += 2) { sx += s.points[i]; sy += s.points[i + 1]; n++; }
    return n ? { x: sx / n, y: sy / n } : null;
  }
  if (Number.isFinite(s?.x) && Number.isFinite(s?.y)) {
    if (Number.isFinite(s.width)) return { x: s.x + s.width / 2, y: s.y + s.height / 2 }; // rect
    return { x: s.x, y: s.y }; // ellipse (center = x,y)
  }
  return null;
}
function _shapesCentroid(shapes) {
  let sx = 0, sy = 0, n = 0;
  for (const s of (shapes ?? [])) { const c = _shapeCenter(s); if (c) { sx += c.x; sy += c.y; n++; } }
  return n ? { x: sx / n, y: sy / n } : null;
}

// Point (x,y) inside a region shape (polygon/rectangle/ellipse). For selecting passengers
// by the OLD geometry (region.tokens already reflects the new shape on a large shift).
function _pointInShape(shape, x, y) {
  if (!shape) return false;
  const t = shape.type;
  if (t === "polygon" && Array.isArray(shape.points) && shape.points.length >= 6) {
    const pts = shape.points; let inside = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  if (t === "rectangle") {
    const sx = shape.x ?? 0, sy = shape.y ?? 0, w = shape.width ?? 0, h = shape.height ?? 0, rot = shape.rotation ?? 0;
    if (!rot) return x >= sx && x <= sx + w && y >= sy && y <= sy + h;
    const cx = sx + w / 2, cy = sy + h / 2, r = -rot * Math.PI / 180, dx = x - cx, dy = y - cy;
    return Math.abs(dx * Math.cos(r) - dy * Math.sin(r)) <= w / 2 && Math.abs(dx * Math.sin(r) + dy * Math.cos(r)) <= h / 2;
  }
  if (t === "ellipse") {
    const cx = shape.x ?? 0, cy = shape.y ?? 0, rx = shape.radiusX ?? 0, ry = shape.radiusY ?? 0;
    if (rx <= 0 || ry <= 0) return false;
    const r = -(shape.rotation ?? 0) * Math.PI / 180, dx = x - cx, dy = y - cy;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
  }
  return false;
}
// Token and region are linked via Mass Edit (shared link.id) → it is the "driver" (boat), not a passenger.
function _sharesMassEditLink(tokenDoc, regionDoc) {
  const tl = tokenDoc?.flags?.["multi-token-edit"]?.links;
  const rl = regionDoc?.flags?.["multi-token-edit"]?.links;
  if (!Array.isArray(tl) || !Array.isArray(rl) || !tl.length || !rl.length) return false;
  const rids = new Set(rl.map((l) => l?.id).filter(Boolean));
  return tl.some((l) => l?.id && rids.has(l.id));
}

// Place the token in a FREE grid cell ON the transport, closest to the ideal center (cx,cy).
// occupied — Set of occupied cells "col,row" (shared across all passengers so they do not collide).
// shapes — the new region shapes (so the cell is ON the transport). Returns {x,y} (top-left).
function _placeOnGrid(cx, cy, tw, th, gs, occupied, shapes) {
  const wCells = Math.max(1, Math.round(tw / gs));
  const hCells = Math.max(1, Math.round(th / gs));
  const col0 = Math.round((cx - tw / 2) / gs);
  const row0 = Math.round((cy - th / 2) / gs);
  const _free = (col, row) => {
    for (let dc = 0; dc < wCells; dc++) for (let dr = 0; dr < hCells; dr++)
      if (occupied.has(`${col + dc},${row + dr}`)) return false;
    return true;
  };
  const _onT = (col, row) => {
    const ccx = col * gs + tw / 2, ccy = row * gs + th / 2;
    return !!shapes?.some((sh) => _pointInShape(sh, ccx, ccy));
  };
  let pick = null;
  for (let r = 0; r <= 8 && !pick; r++) {           // spiral outward from the ideal
    for (let dc = -r; dc <= r && !pick; dc++) for (let dr = -r; dr <= r && !pick; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue; // only the ring of radius r
      const col = col0 + dc, row = row0 + dr;
      if (_free(col, row) && _onT(col, row)) pick = { col, row };
    }
  }
  if (!pick) pick = { col: col0, row: row0 };        // nothing free on the transport — the ideal (better than nothing)
  for (let dc = 0; dc < wCells; dc++) for (let dr = 0; dr < hCells; dr++)
    occupied.add(`${pick.col + dc},${pick.row + dr}`);
  return { x: pick.col * gs, y: pick.row * gs };
}

// Two-phase (important!): snapshot of passengers + old geometry in preUpdateRegion,
// and the carry ITSELF in updateRegion (after commit). A nested updateEmbeddedDocuments
// right inside preUpdate caused ordering failures (token "jumped off"/did not ride in some directions/rotations).
const _pendingCarry = new Map(); // regionId → { oldShapes, passengers:[{id,cx,cy,rot,tw,th}] }

Hooks.on("preUpdateRegion", (region, changed) => {
  if (!_regionsOn()) return;
  if (!game.user?.isGM) return;
  if (region.getFlag(MODULE_ID, FLAG_TYPE) !== "transport") return;
  if (!changed?.shapes) return;                 // the region did not move (other fields changed)
  if (_isRegionEffectivelyDisabled(region)) return;
  const gs = Number(canvas?.grid?.size) || 100;
  const oldShapes = region._source?.shapes ?? region.shapes;
  // Passengers are computed OURSELVES by the OLD region shape (point-in-shape), NOT from region.tokens:
  // on a large shift/rotation (e.g. 180°+shift) the Foundry set already reflects the new shape → passengers were lost.
  const passengers = [];
  for (const tok of (canvas?.tokens?.placeables ?? [])) {
    const td = tok?.document;
    if (!td?.id) continue;
    if (_sharesMassEditLink(td, region)) continue;   // the "driver" (boat), co-linked with the region — not carried (else double shift)
    const tw = (Number(td.width ?? 1) || 1) * gs, th = (Number(td.height ?? 1) || 1) * gs;
    // _source — raw committed coordinates (no animation interpolation of the previous carry),
    // as in _ignoresRegionEffects — otherwise a passenger could drop out of the snapshot while moving.
    const cx = (td._source?.x ?? td.x ?? 0) + tw / 2, cy = (td._source?.y ?? td.y ?? 0) + th / 2;
    if (!oldShapes?.some((sh) => _pointInShape(sh, cx, cy))) continue; // not inside the OLD region
    const elev = Number(td._source?.elevation ?? td.elevation ?? 0);
    const floor = _surfaceFloorAt(cx, cy, elev); // floor under the token: land OR water surface (not 0 over water!)
    if (elev > floor + 0.5) continue;            // flying/climbing ABOVE the floor → not on the transport, not carried
    passengers.push({ id: td.id, cx, cy, rot: td.rotation ?? 0, tw, th, elev });
  }
  if (!passengers.length) return;
  _pendingCarry.set(region.id, { oldShapes: foundry.utils.deepClone(oldShapes), passengers });
});

Hooks.on("updateRegion", (region, _changed) => {
  if (!game.user?.isGM) return;
  const pend = _pendingCarry.get(region.id);
  if (!pend) return;
  _pendingCarry.delete(region.id);
  const newShapes = region._source?.shapes ?? region.shapes; // already committed
  const oldC = _shapesCentroid(pend.oldShapes), newC = _shapesCentroid(newShapes);
  if (!oldC || !newC) return;
  let theta = _admPolyRotationDelta(pend.oldShapes, newShapes) ?? 0; // rad; orbit around the centroid = around the region center
  if (!Number.isFinite(theta)) theta = 0;                          // guard: do not drop the carry because of a NaN angle
  const dx = newC.x - oldC.x, dy = newC.y - oldC.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(theta) < 0.001) return;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const gs = Number(canvas?.grid?.size) || 100;
  const occupied = new Set();                                     // occupied cells — so passengers do not collide
  const upd = [];
  for (const p of pend.passengers) {
    const lx = p.cx - oldC.x, ly = p.cy - oldC.y;                 // local offset from the old centroid
    const nx = newC.x + (lx * cos - ly * sin);                   // rigid transform: shift + rotation (ideal center)
    const ny = newC.y + (lx * sin + ly * cos);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;  // NaN guard — do not drop the whole update
    // Place into the nearest FREE grid cell ON the transport (no collisions) — shifted slightly, but grid-aligned.
    const cell = _placeOnGrid(nx, ny, p.tw, p.th, gs, occupied, newShapes);
    // The passenger's elevation is SET EQUAL to the surface under its NEW cell (the same _surfaceFloorAt the boat
    // snaps to in createTerrainMovementPath) and sent IN THE SAME animate update as x/y. Otherwise the passenger's
    // elevation is frozen (carry did not touch it) while the boat ANIMATES its own → in frames where the boat's
    // elevation > passenger's, the boat (elevation dominates sort) is drawn ON TOP → "passenger under the boat". Now
    // elevation interpolates in sync with position and arrives at the same surface as the boat → sort keeps 1×1 on top.
    const passElev = _surfaceFloorAt(cell.x + p.tw / 2, cell.y + p.th / 2, p.elev);
    const u = { _id: p.id, x: cell.x, y: cell.y, elevation: passElev };
    if (Math.abs(theta) > 0.001) u.rotation = (((p.rot + theta * 180 / Math.PI) % 360) + 360) % 360;
    upd.push(u);
  }
  if (upd.length) {
    // ANIMATED, but FREE: animate:true → passengers glide smoothly. During the update we set
    // __admFreeMovement — the _shouldRecordMovementHistory wrapper (ready hook below) returns false →
    // Foundry does NOT write to movementHistory → the transport carry does not spend players' movement in combat.
    // Animation is independent of history recording (recording = budget only). _admBindingMove → bypass
    // of the system's token-spacing ("push apart?") prompt + activation trackers.
    const _scene = region.parent ?? canvas.scene;
    // try/finally guarantees the decrement even on a SYNCHRONOUS throw from updateEmbeddedDocuments
    // (otherwise the counter sticks at >0 → ALL movement becomes free). Increment before try.
    (async () => {
      globalThis.__admFreeMovement = (Number(globalThis.__admFreeMovement) || 0) + 1;
      try {
        await _scene?.updateEmbeddedDocuments("Token", upd, { animate: true, _admBindingMove: true });
      } catch (e) { console.warn("[adm-levels] transport carry", e); }
      finally { globalThis.__admFreeMovement = Math.max(0, (Number(globalThis.__admFreeMovement) || 1) - 1); }
    })();
  }
});

// Token flags (state for water)
const TFLAG_IN_WATER = "inWater";
const TFLAG_PREV_MOV = "prevMovementAction";

/** All height options in order. Value → label key. */
const HEIGHT_OPTIONS = [
  { value: "veryFar",  label: "ADM_LEVELS.h.veryFar",  ft: 120 },
  { value: "far",      label: "ADM_LEVELS.h.far",      ft: 60 },
  { value: "medium",   label: "ADM_LEVELS.h.medium",   ft: 30 },
  { value: "close",    label: "ADM_LEVELS.h.close",    ft: 15 },
  { value: "",         label: "ADM_LEVELS.h.ground",   ft: 0 },
  { value: "-close",   label: "ADM_LEVELS.h.nclose",   ft: -15 },
  { value: "-medium",  label: "ADM_LEVELS.h.nmedium",  ft: -30 },
  { value: "-far",     label: "ADM_LEVELS.h.nfar",     ft: -60 },
  { value: "-veryFar", label: "ADM_LEVELS.h.nveryFar", ft: -120 },
];

/** Is this a custom numeric key (e.g. "10", "-20")? */
function _isCustomKey(key) {
  return /^-?\d+(?:\.\d+)?$/.test(String(key ?? "").trim());
}

/** Signed key → feet. */
function _keyToFt(key) {
  if (!key) return 0;
  // Fix corrupted comma-separated values from earlier bug.
  const clean = String(key).includes(",") ? String(key).split(",").pop().trim() : String(key).trim();
  if (_isCustomKey(clean)) return Number(clean) || 0;
  const entry = HEIGHT_OPTIONS.find(h => h.value === clean);
  return entry?.ft ?? 0;
}

/** Get display name for a signed key. */
function _keyLabel(key) {
  if (_isCustomKey(key)) {
    const n = Number(key);
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n} ft`;
  }
  const entry = HEIGHT_OPTIONS.find(h => h.value === key);
  return entry ? game.i18n.localize(entry.label) : game.i18n.localize("ADM_LEVELS.h.ground");
}

/** Signed key → English label in feet for the region auto-name, e.g. "0ft", "15ft", "-15ft". */
function _ftLabel(key) {
  return `${_keyToFt(key)}ft`;
}

function _cellFt() {
  return Number(canvas?.scene?.grid?.distance ?? 5) || 5;
}

/** Build <option> HTML for a height select. */
function _buildHeightOptions(selected) {
  const isCustom = _isCustomKey(selected);
  const opts = HEIGHT_OPTIONS.map(h => {
    const label = game.i18n.localize(h.label);
    const sel = (!isCustom && h.value === (selected ?? "")) ? " selected" : "";
    return `<option value="${h.value}"${sel}>${label}</option>`;
  }).join("");
  const customSel = isCustom ? " selected" : "";
  const customLabel = game.i18n.localize("ADM_LEVELS.h.custom") || "Custom (feet)";
  return opts + `<option value="custom"${customSel}>${customLabel}…</option>`;
}

/* ------------------------------------------------------------------ */
/*  Inject UI into RegionConfig                                       */
/* ------------------------------------------------------------------ */

Hooks.on("renderRegionConfig", (app, element) => {
  // Master switch: do not inject the type selector into the region window — new elevation regions
  // cannot be created, and existing ones simply have no effect (flags stay intact).
  if (!_regionsOn()) return;
  const colorInput = element.querySelector('[name="color"]');
  if (!colorInput) return;
  const colorGroup = colorInput.closest(".form-group");
  if (!colorGroup) return;
  if (element.querySelector("[data-adm-levels]")) return;

  const doc = app.document;
  const type = doc.getFlag(MODULE_ID, FLAG_TYPE) ?? "";
  const elev = doc.getFlag(MODULE_ID, FLAG_ELEVATION) ?? "";
  const floor = doc.getFlag(MODULE_ID, FLAG_FLOOR) ?? "";
  const dir = doc.getFlag(MODULE_ID, FLAG_DIRECTION) ?? 0;
  const disabled = !!doc.getFlag(MODULE_ID, FLAG_DISABLED);
  const tileBindId = doc.getFlag(MODULE_ID, FLAG_TILE_BIND) ?? "";
  const tileInvert = !!doc.getFlag(MODULE_ID, FLAG_TILE_INVERT);
  const ignoreEffects = !!doc.getFlag(MODULE_ID, FLAG_IGNORE_EFFECTS);
  const boundTile = tileBindId ? (doc.parent ?? canvas.scene)?.tiles?.get(tileBindId) : null;
  const tileLabel = boundTile ? `${tileBindId.slice(0, 8)}… (${Math.round(boundTile.x)},${Math.round(boundTile.y)})` : "—";

  const html = `
    <div class="form-group" data-adm-levels>
      <label>${game.i18n.localize("ADM_LEVELS.ui.type")}</label>
      <div class="form-fields">
        <select data-adm-type style="flex:1;">
          <option value="">${game.i18n.localize("ADM_LEVELS.ui.none")}</option>
          <option value="plateau" ${type === "plateau" ? "selected" : ""}>${game.i18n.localize("ADM_LEVELS.ui.plateau")}</option>
          <option value="stairs" ${type === "stairs" ? "selected" : ""}>${game.i18n.localize("ADM_LEVELS.ui.stairs")}</option>
          <option value="water" ${type === "water" ? "selected" : ""}>${game.i18n.localize("ADM_LEVELS.ui.water")}</option>
          <option value="transport" ${type === "transport" ? "selected" : ""}>${game.i18n.localize("ADM_LEVELS.ui.transport")}</option>
        </select>
        <!-- Named inputs live INSIDE form-groups on purpose (Mass Edit, Ctrl+E on several regions):
             it gives a group its "apply" checkbox only when the group contains a [name] field, and on
             save collects [name] fields only from ticked groups. Type / elevation / floor / transition /
             direction are one unit (they only mean something together with the type), so they sit in
             the type group; the plateau/water/stairs/ring controls tick this group via _meTick. -->
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TYPE}" value="${type}">
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_ELEVATION}" value="${elev || (type === "stairs" ? "medium" : "")}">
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_FLOOR}" value="${floor}">
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TRANSITION}" value="${type === "stairs" ? "true" : ""}">
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_DIRECTION}" value="${dir}">
      </div>
    </div>
    <div class="form-group" data-adm-plateau style="display:${type === "plateau" ? "flex" : "none"};">
      <label>${game.i18n.localize("ADM_LEVELS.ui.height")}</label>
      <div class="form-fields" style="display:flex;gap:6px;">
        <select data-adm-plateau-h style="flex:1;">
          ${_buildHeightOptions(elev)}
        </select>
        <input type="number" data-adm-plateau-h-custom step="1" placeholder="ft"
               value="${_isCustomKey(elev) ? elev : ""}"
               style="flex:0 0 90px;display:${_isCustomKey(elev) ? "block" : "none"};">
      </div>
    </div>
    <div class="form-group" data-adm-water-group style="display:${type === "water" ? "flex" : "none"};">
      <label>${game.i18n.localize("ADM_LEVELS.ui.water")}</label>
      <div class="form-fields" style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="flex:0 0 90px;opacity:0.85;">${game.i18n.localize("ADM_LEVELS.ui.surface")}</span>
          <select data-adm-water-surf style="flex:1;">
            ${_buildHeightOptions(elev)}
          </select>
          <input type="number" data-adm-water-surf-custom step="1" placeholder="ft"
                 value="${_isCustomKey(elev) ? elev : ""}"
                 style="flex:0 0 80px;visibility:${_isCustomKey(elev) ? "visible" : "hidden"};">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="flex:0 0 90px;opacity:0.85;">${game.i18n.localize("ADM_LEVELS.ui.depth")}</span>
          <select data-adm-water-bot style="flex:1;">
            ${_buildHeightOptions(floor)}
          </select>
          <input type="number" data-adm-water-bot-custom step="1" placeholder="ft"
                 value="${_isCustomKey(floor) ? floor : ""}"
                 style="flex:0 0 80px;visibility:${_isCustomKey(floor) ? "visible" : "hidden"};">
        </div>
      </div>    </div>
    <div class="form-group" data-adm-stairs style="display:${type === "stairs" ? "flex" : "none"};">
      <label>${game.i18n.localize("ADM_LEVELS.ui.stairs")}</label>
      <div class="form-fields" style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <select data-adm-stairs-lo style="flex:1;">
            ${_buildHeightOptions(floor)}
          </select>
          <canvas class="adm-dir-ring" width="44" height="44" style="cursor:pointer;border-radius:50%;border:1px solid #555;flex:0 0 44px;"></canvas>
          <select data-adm-stairs-hi style="flex:1;">
            ${_buildHeightOptions(elev || "medium")}
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" data-adm-stairs-lo-custom step="1" placeholder="ft"
                 value="${_isCustomKey(floor) ? floor : ""}"
                 style="flex:1;visibility:${_isCustomKey(floor) ? "visible" : "hidden"};">
          <div style="flex:0 0 44px;"></div>
          <input type="number" data-adm-stairs-hi-custom step="1" placeholder="ft"
                 value="${_isCustomKey(elev) ? elev : ""}"
                 style="flex:1;visibility:${_isCustomKey(elev) ? "visible" : "hidden"};">
        </div>
      </div>    </div>
    <div class="form-group" data-adm-transport-group style="display:${type === "transport" ? "flex" : "none"};">
      <label>${game.i18n.localize("ADM_LEVELS.ui.transport")}</label>
      <div class="form-fields">
        <label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
          <input type="checkbox" data-adm-transport-ignore name="flags.${MODULE_ID}.${FLAG_IGNORE_EFFECTS}" ${ignoreEffects ? "checked" : ""}>
          <span style="font-size:12px;">${game.i18n.localize("ADM_LEVELS.ui.transportIgnore")}</span>
        </label>
      </div>    </div>
    <div class="form-group" data-adm-disabled-group style="display:${type ? "flex" : "none"};">
      <label>${game.i18n.localize("ADM_LEVELS.ui.disable")}</label>
      <div class="form-fields">
        <input type="checkbox" data-adm-disabled name="flags.${MODULE_ID}.${FLAG_DISABLED}" ${disabled ? "checked" : ""}>      </div>
    </div>
    <div class="form-group" data-adm-bind-group style="display:${type ? "flex" : "none"};align-items:center;">
      <label>${game.i18n.localize("ADM_LEVELS.ui.tileBind")}</label>
      <div class="form-fields" style="display:flex;align-items:center;gap:6px;">
        <!-- Right-aligned row: bound tile, clear, pick, invert — the controls sit together next to the checkbox. -->
        <span data-adm-tile-display style="flex:1;min-width:0;text-align:right;opacity:.85;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tileLabel}</span>
        <button type="button" data-adm-clear-tile style="flex:0 0 auto;padding:3px 6px;line-height:1;${tileBindId ? "" : "display:none;"}" title="${game.i18n.localize("ADM_LEVELS.ui.clearBind")}">×</button>
        <button type="button" data-adm-pick-tile style="flex:0 0 auto;padding:3px 8px;">${game.i18n.localize("ADM_LEVELS.ui.pickTile")}</button>
        <!-- Caption BEFORE the checkbox: the box ends the row, right under the "Disable region" box. -->
        <label style="flex:0 0 auto;display:flex;align-items:center;gap:6px;font-weight:normal;margin:0;" title="${game.i18n.localize("ADM_LEVELS.ui.invertRegion")}">
          <span style="font-size:11px;opacity:.85;">${game.i18n.localize("ADM_LEVELS.ui.invertShort")}</span>
          <input type="checkbox" data-adm-tile-invert ${tileInvert ? "checked" : ""}>
        </label>
        <!-- Tile binding is independent of the type — its own Mass Edit group (see the type group). -->
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TILE_BIND}" value="${tileBindId}">
        <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TILE_INVERT}" value="${tileInvert ? "true" : ""}">
      </div>
    </div>`;

  colorGroup.insertAdjacentHTML("afterend", html);

  // Remove any Foundry-auto-generated inputs for our flags to avoid duplicates.
  const allMyFlags = [FLAG_TYPE, FLAG_ELEVATION, FLAG_FLOOR, FLAG_TRANSITION, FLAG_DIRECTION, FLAG_DISABLED, FLAG_TILE_BIND, FLAG_TILE_INVERT, FLAG_IGNORE_EFFECTS, "negative"];
  for (const f of allMyFlags) {
    const name = `flags.${MODULE_ID}.${f}`;
    const dupes = element.querySelectorAll(`[name="${name}"]`);
    // Keep only the LAST one (ours), remove earlier Foundry-generated ones.
    if (dupes.length > 1) {
      for (let i = 0; i < dupes.length - 1; i++) dupes[i].remove();
    }
  }

  // Gather elements — use `element` (full form) for reliable lookup.
  const typeSelect = element.querySelector("[data-adm-type]");
  const plateauGroup = element.querySelector("[data-adm-plateau]");
  const stairsGroup = element.querySelector("[data-adm-stairs]");
  const waterGroup = element.querySelector("[data-adm-water-group]");
  const transportGroup = element.querySelector("[data-adm-transport-group]");
  const plateauH = element.querySelector("[data-adm-plateau-h]");
  const plateauHCustom = element.querySelector("[data-adm-plateau-h-custom]");
  const stairsLo = element.querySelector("[data-adm-stairs-lo]");
  const stairsLoCustom = element.querySelector("[data-adm-stairs-lo-custom]");
  const stairsHi = element.querySelector("[data-adm-stairs-hi]");
  const stairsHiCustom = element.querySelector("[data-adm-stairs-hi-custom]");
  const waterSurf = element.querySelector("[data-adm-water-surf]");
  const waterSurfCustom = element.querySelector("[data-adm-water-surf-custom]");
  const waterBot = element.querySelector("[data-adm-water-bot]");
  const waterBotCustom = element.querySelector("[data-adm-water-bot-custom]");
  const hiddenType = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_TYPE}"]`);
  const hiddenElev = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_ELEVATION}"]`);
  const hiddenFloor = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_FLOOR}"]`);
  const hiddenTrans = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_TRANSITION}"]`);
  const hiddenDir = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_DIRECTION}"]`);
  const nameInput = element.querySelector('[name="name"]');
  const ringCanvas = element.querySelector(".adm-dir-ring");

  // Returns the effective select value: for "custom" — the input value (numeric string).
  function _effVal(sel, input) {
    if (sel.value === "custom") {
      const v = String(input?.value ?? "").trim();
      if (v === "" || isNaN(Number(v))) return "";
      return String(Number(v));
    }
    return sel.value;
  }

  // Show/hide the custom input depending on the select choice.
  // For stairs/water use visibility to keep the position in the flex row.
  function _toggleCustom(sel, input) {
    if (!input) return;
    const isRowLayout = input.hasAttribute("data-adm-stairs-lo-custom")
                     || input.hasAttribute("data-adm-stairs-hi-custom")
                     || input.hasAttribute("data-adm-water-surf-custom")
                     || input.hasAttribute("data-adm-water-bot-custom");
    if (isRowLayout) {
      input.style.visibility = sel.value === "custom" ? "visible" : "hidden";
    } else {
      input.style.display = sel.value === "custom" ? "block" : "none";
    }
  }

  // Sync visible selects → hidden inputs.
  function _syncHidden() {
    const t = hiddenType.value;
    if (t === "plateau") {
      hiddenElev.value = _effVal(plateauH, plateauHCustom);
      hiddenFloor.value = "";
    } else if (t === "stairs") {
      hiddenElev.value = _effVal(stairsHi, stairsHiCustom);
      hiddenFloor.value = _effVal(stairsLo, stairsLoCustom);
    } else if (t === "water") {
      hiddenElev.value = _effVal(waterSurf, waterSurfCustom);
      hiddenFloor.value = _effVal(waterBot, waterBotCustom);
    } else {
      hiddenElev.value = "";
      hiddenFloor.value = "";
    }
  }

  // Auto-color based on max elevation.
  const ELEV_COLORS = {
    "close": "#22c55e", "-close": "#22c55e",
    "medium": "#eab308", "-medium": "#eab308",
    "far": "#f97316", "-far": "#f97316",
    "veryFar": "#ef4444", "-veryFar": "#ef4444",
  };

  // Track pending color/visibility to apply on save.
  let _pendingColor = null;

  function _autoColor() {
    const t = hiddenType.value;
    // Water is always blue.
    if (t === "water") { _pendingColor = "#3b82f6"; return; }
    // Transport is a purple zone (region effects are ignored).
    if (t === "transport") { _pendingColor = "#a855f7"; return; }
    let key = "";
    if (t === "plateau") key = _effVal(plateauH, plateauHCustom);
    else if (t === "stairs") key = _effVal(stairsHi, stairsHiCustom);
    let color = ELEV_COLORS[key];
    // For custom feet — pick the color by range
    if (!color && _isCustomKey(key)) {
      const abs = Math.abs(Number(key) || 0);
      if      (abs <=  15) color = "#22c55e";
      else if (abs <=  30) color = "#eab308";
      else if (abs <=  60) color = "#f97316";
      else                 color = "#ef4444";
    }
    if (color) _pendingColor = color;
  }

  // Apply color + opacity after form submit.
  Hooks.once("closeRegionConfig", async () => {
    const regionDoc = app.document;
    const updates = {};
    if (_pendingColor) updates.color = _pendingColor;
    const alpha = regionDoc.flags?.tokenmagic?.regionData?.alpha;
    if (alpha == null || alpha > 0.25) updates["flags.tokenmagic.regionData.alpha"] = 0.25;
    if (Object.keys(updates).length) {
      await regionDoc.update(updates);
      regionDoc.object?.refresh();
    }
  });

  // Auto-rename region.
  function _autoRename() {
    if (!nameInput) return;
    const t = hiddenType.value;
    // Name in feet, in English (e.g. "0ft ↑ 15ft"), without localized height names.
    if (t === "plateau") {
      nameInput.value = _ftLabel(_effVal(plateauH, plateauHCustom));
    } else if (t === "stairs") {
      const dir = Number(hiddenDir.value) || 0;
      const arrows = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];
      const arrow = arrows[Math.round(dir / 45) % 8];
      nameInput.value = `${_ftLabel(_effVal(stairsLo, stairsLoCustom))} ${arrow} ${_ftLabel(_effVal(stairsHi, stairsHiCustom))}`;
    } else if (t === "water") {
      nameInput.value = `${_ftLabel(_effVal(waterSurf, waterSurfCustom))} / ${_ftLabel(_effVal(waterBot, waterBotCustom))}`;
    }
  }

  // Mass Edit (Ctrl+E on several regions): tick the "apply" checkbox of a form-group whose
  // [name] inputs we just changed from OUTSIDE that group (height/water/stairs controls and the
  // direction ring write into the type group's hidden inputs; Mass Edit only auto-ticks the
  // group the clicked control sits in). No-op in the stock single-region window (no checkbox).
  function _meTick(group) {
    const cb = group?.querySelector?.(".mass-edit-checkbox input");
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  const typeGroup = element.querySelector("[data-adm-levels]");

  function _onAnyChange() { _syncHidden(); _autoRename(); _autoColor(); _meTick(typeGroup); }

  // Type switch.
  typeSelect.addEventListener("change", () => {
    const t = typeSelect.value;
    hiddenType.value = t;
    hiddenTrans.value = t === "stairs" ? "true" : "";
    plateauGroup.style.display = t === "plateau" ? "flex" : "none";
    stairsGroup.style.display = t === "stairs" ? "flex" : "none";
    waterGroup.style.display = t === "water" ? "flex" : "none";
    if (transportGroup) transportGroup.style.display = t === "transport" ? "flex" : "none";
    const disabledGroup = element.querySelector("[data-adm-disabled-group]");
    if (disabledGroup) disabledGroup.style.display = t ? "flex" : "none";
    const bindGroup = element.querySelector("[data-adm-bind-group]");
    if (bindGroup) bindGroup.style.display = t ? "flex" : "none";
    if (t === "stairs") {
      if (!stairsHi.value) stairsHi.value = "medium";
      _drawDirRing(ringCanvas, hiddenDir);
    }
    if (t === "water") {
      if (!waterSurf.value) waterSurf.value = "";          // default "Ground" (0)
      if (!waterBot.value)  waterBot.value  = "-close";    // -15 — shallow water
    }
    _onAnyChange();
  });

  function _selChange(sel, input) {
    _toggleCustom(sel, input);
    if (sel.value === "custom" && input && !input.value) input.focus();
    _onAnyChange();
  }

  plateauH.addEventListener("change", () => _selChange(plateauH, plateauHCustom));
  stairsLo.addEventListener("change", () => _selChange(stairsLo, stairsLoCustom));
  stairsHi.addEventListener("change", () => _selChange(stairsHi, stairsHiCustom));
  waterSurf?.addEventListener("change", () => _selChange(waterSurf, waterSurfCustom));
  waterBot?.addEventListener("change", () => _selChange(waterBot, waterBotCustom));

  plateauHCustom?.addEventListener("input", _onAnyChange);
  stairsLoCustom?.addEventListener("input", _onAnyChange);
  stairsHiCustom?.addEventListener("input", _onAnyChange);
  waterSurfCustom?.addEventListener("input", _onAnyChange);
  waterBotCustom?.addEventListener("input", _onAnyChange);

  // --- Tile binding controls ---
  const pickTileBtn   = element.querySelector("[data-adm-pick-tile]");
  const clearTileBtn  = element.querySelector("[data-adm-clear-tile]");
  const tileDisplay   = element.querySelector("[data-adm-tile-display]");
  const tileInvertCb  = element.querySelector("[data-adm-tile-invert]");
  const hiddenTileBind   = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_TILE_BIND}"]`);
  const hiddenTileInvert = element.querySelector(`[name="flags.${MODULE_ID}.${FLAG_TILE_INVERT}"]`);

  function _setTileBinding(tileId) {
    if (!hiddenTileBind) return;
    hiddenTileBind.value = tileId || "";
    // Our pick/clear buttons stop propagation, so Mass Edit's delegated click handler never
    // ticks the bind group itself — do it here.
    _meTick(element.querySelector("[data-adm-bind-group]"));
    if (tileDisplay) {
      if (tileId) {
        const t = (app.document?.parent ?? canvas.scene)?.tiles?.get(tileId);
        const coords = t ? `(${Math.round(t.x)},${Math.round(t.y)})` : "";
        tileDisplay.textContent = `${tileId.slice(0, 8)}… ${coords}`;
      } else {
        tileDisplay.textContent = "—";
      }
    }
    // display, not visibility: a hidden "×" must not leave a gap before the pick button.
    if (clearTileBtn) clearTileBtn.style.display = tileId ? "" : "none";
  }

  pickTileBtn?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ui.notifications?.info?.(game.i18n.localize("ADM_LEVELS.ui.clickTile"));
    pickTileBtn.disabled = true;
    pickTileBtn.textContent = game.i18n.localize("ADM_LEVELS.ui.pickTileWait");
    try {
      const tile = await _pickTileOnCanvas();
      if (tile) _setTileBinding(tile.id);
    } catch (e) { console.warn("[adm-levels] pick tile", e); }
    finally {
      pickTileBtn.disabled = false;
      pickTileBtn.textContent = game.i18n.localize("ADM_LEVELS.ui.pickTile");
    }
  });

  clearTileBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    _setTileBinding("");
  });

  tileInvertCb?.addEventListener("change", () => {
    if (hiddenTileInvert) hiddenTileInvert.value = tileInvertCb.checked ? "true" : "";
  });

  // --- Direction ring widget ---
  function _drawDirRing(cvs, input) {
    const ctx = cvs.getContext("2d");
    const w = cvs.width, h = cvs.height;
    const cx = w / 2, cy = h / 2, r = w / 2 - 4;
    const deg = Number(input.value) || 0;
    const rad = ((deg + 90) * Math.PI) / 180;
    const dotX = cx + Math.cos(rad) * r;
    const dotY = cy + Math.sin(rad) * r;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#999"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dotX, dotY);
    ctx.strokeStyle = "#f80"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#f80"; ctx.fill();
  }

  function _onRingInteract(e) {
    const rect = ringCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    let deg = (Math.atan2(my, mx) * 180) / Math.PI - 90;
    if (deg < 0) deg += 360;
    deg = Math.round(deg / 30) * 30 % 360; // snap to 12 positions
    hiddenDir.value = deg;
    _drawDirRing(ringCanvas, hiddenDir);
    _autoRename();
    _meTick(typeGroup); // direction lives in the type group (Mass Edit)
  }

  ringCanvas.addEventListener("pointerdown", (e) => {
    _onRingInteract(e);
    const onMove = (ev) => _onRingInteract(ev);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  hiddenDir.addEventListener("change", () => { _drawDirRing(ringCanvas, hiddenDir); _autoRename(); });

  if (type === "stairs") _drawDirRing(ringCanvas, hiddenDir);
});

/* ------------------------------------------------------------------ */
/*  Ramp elevation calculation                                        */
/* ------------------------------------------------------------------ */

function _regionBounds(region) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of region.document.shapes) {
    if (shape.points?.length) {
      for (let i = 0; i < shape.points.length; i += 2) {
        const x = shape.points[i], y = shape.points[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    } else if (shape.width != null && shape.height != null) {
      const x0 = shape.x ?? 0, y0 = shape.y ?? 0;
      if (x0 < minX) minX = x0; if (x0 + shape.width > maxX) maxX = x0 + shape.width;
      if (y0 < minY) minY = y0; if (y0 + shape.height > maxY) maxY = y0 + shape.height;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Ramp direction as a unit vector (-sin, cos). Near-zero components are snapped to 0: cos(90°) is
 *  6e-17, not 0, and that noise times the y coordinate used to decide how cell centres lying exactly
 *  halfway between two heights were rounded (the same stairs read 10/5/0 in one spot, 15/5/0 in another). */
function _rampDir(doc) {
  const dir = Number(doc.getFlag(MODULE_ID, FLAG_DIRECTION) ?? 0) || 0;
  const rad = (dir * Math.PI) / 180;
  const snap = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { dx: snap(-Math.sin(rad)), dy: snap(Math.cos(rad)) };
}

/** Bounding boxes of the region's separate ramps. Non-hole shapes whose boxes touch or overlap form
 *  one ramp; a shape standing apart is a ramp of its own. Before, two stairs in one region were
 *  stretched into a single ramp over the box of both. */
function _rampPieces(region) {
  const boxes = [];
  for (const shape of region.document.shapes) {
    if (shape.hole) continue;
    if (shape.points?.length) {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 0; i < shape.points.length; i += 2) {
        const x = shape.points[i], y = shape.points[i + 1];
        if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
      }
      if (Number.isFinite(b.minX)) boxes.push(b);
    } else if (shape.width != null && shape.height != null) {
      const x0 = shape.x ?? 0, y0 = shape.y ?? 0;
      boxes.push({ minX: x0, minY: y0, maxX: x0 + shape.width, maxY: y0 + shape.height });
    }
  }
  const parent = boxes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b) => a.minX <= b.maxX + 1 && b.minX <= a.maxX + 1 && a.minY <= b.maxY + 1 && b.minY <= a.maxY + 1;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (touch(boxes[i], boxes[j])) parent[find(i)] = find(j);
  }
  const pieces = new Map();
  boxes.forEach((b, i) => {
    const r = find(i), p = pieces.get(r);
    if (!p) { pieces.set(r, { ...b }); return; }
    p.minX = Math.min(p.minX, b.minX); p.minY = Math.min(p.minY, b.minY);
    p.maxX = Math.max(p.maxX, b.maxX); p.maxY = Math.max(p.maxY, b.maxY);
  });
  return [...pieces.values()];
}

/** Box of the ramp that holds the point; the whole region's box if no single ramp does.
 *  `pieces` may be passed in when many points of one region are asked (the labels loop). */
function _rampBoundsAt(region, x, y, pieces = _rampPieces(region)) {
  if (pieces.length === 1) return pieces[0];
  const hit = pieces.find((b) => x >= b.minX - 1 && x <= b.maxX + 1 && y >= b.minY - 1 && y <= b.maxY + 1);
  return hit ?? _regionBounds(region);
}

/** Position of a point along a ramp box: 0 at the foot, 1 at the top; null if the box is flat. */
function _rampT(b, dx, dy, x, y) {
  let pMin = Infinity, pMax = -Infinity;
  for (const [cx, cy] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]]) {
    const p = cx * dx + cy * dy;
    if (p < pMin) pMin = p; if (p > pMax) pMax = p;
  }
  const range = pMax - pMin;
  if (range < 1) return null;
  return Math.max(0, Math.min(1, (x * dx + y * dy - pMin) / range));
}

/** Ramp height snapped to the grid step. A cell centre often lies exactly halfway between two heights
 *  (15 ft over three cells: 2.5 / 7.5 / 12.5); the epsilon always rounds such a tie up. */
function _rampSnapFt(rawFt) {
  const cellFt = _cellFt();
  return Math.round(rawFt / cellFt + 1e-6) * cellFt;
}

function _computeRampElevation(region, px, py) {
  const doc = region.document;
  const topFt = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
  const botFt = _keyToFt(doc.getFlag(MODULE_ID, FLAG_FLOOR));

  const bounds = _rampBoundsAt(region, px, py);
  if (!bounds) return topFt;

  const { dx, dy } = _rampDir(doc);
  const t = _rampT(bounds, dx, dy, px, py);
  if (t === null) return topFt;

  return _rampSnapFt(botFt + t * (topFt - botFt));
}

/* ------------------------------------------------------------------ */
/*  Arrow overlay on stairs regions                                   */
/* ------------------------------------------------------------------ */

const _RAMP_OVERLAY_KEY = "__admLevelsRampOverlay";

function _drawRampArrow(region) {
  _clearRampOverlay(region);
  if (!_regionsOn()) return;   // master switch: no ramp arrows
  const doc = region.document;
  if (doc.getFlag(MODULE_ID, FLAG_TYPE) !== "stairs") return;
  if (_isRegionEffectivelyDisabled(doc)) return;

  const bounds = _regionBounds(region);
  if (!bounds) return;

  const { dx: ddx, dy: ddy } = _rampDir(doc);
  const gs = Number(canvas.grid?.size) || 100;
  const px = -ddy, py = ddx;

  // Container for everything.
  const container = new PIXI.Container();
  container.eventMode = "none";

  // Draw an arrow on EACH shape.
  for (const shape of doc.shapes) {
    let scx, scy, sLen;
    if (shape.width != null) {
      scx = (shape.x ?? 0) + (shape.width ?? 0) / 2;
      scy = (shape.y ?? 0) + (shape.height ?? 0) / 2;
      // Length along direction for this shape.
      const sw = shape.width ?? 0, sh = shape.height ?? 0;
      sLen = Math.abs(sw * ddx) + Math.abs(sh * ddy);
    } else if (shape.points?.length >= 6) {
      const pts = shape.points;
      let sx = 0, sy = 0;
      for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sy += pts[i+1]; }
      scx = sx / (pts.length / 2); scy = sy / (pts.length / 2);
      sLen = gs * 2;
    } else continue;

    const arrowLen = Math.min(gs * 1.2, sLen * 0.6);
    if (arrowLen < 10) continue;
    const headSize = arrowLen * 0.35;
    const shaftW = Math.max(gs * 0.05, arrowLen * 0.08);
    const tailX = scx - ddx * arrowLen / 2, tailY = scy - ddy * arrowLen / 2;
    const hbX = scx + ddx * (arrowLen / 2 - headSize), hbY = scy + ddy * (arrowLen / 2 - headSize);
    const tipX = scx + ddx * arrowLen / 2, tipY = scy + ddy * arrowLen / 2;

    const arrow = new PIXI.Graphics();
    arrow.beginFill(0xffffff, 0.3);
    arrow.moveTo(tailX + px * shaftW, tailY + py * shaftW);
    arrow.lineTo(hbX + px * shaftW, hbY + py * shaftW);
    arrow.lineTo(hbX + px * headSize * 0.5, hbY + py * headSize * 0.5);
    arrow.lineTo(tipX, tipY);
    arrow.lineTo(hbX - px * headSize * 0.5, hbY - py * headSize * 0.5);
    arrow.lineTo(hbX - px * shaftW, hbY - py * shaftW);
    arrow.lineTo(tailX - px * shaftW, tailY - py * shaftW);
    arrow.closePath(); arrow.endFill();
    container.addChild(arrow);
  }

  // Labels — masked to region shape.
  const topFt = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
  const botFt = _keyToFt(doc.getFlag(MODULE_ID, FLAG_FLOOR));
  const TextClass = foundry?.canvas?.containers?.PreciseText ?? PIXI.Text;
  const fontSize = Math.max(10, Math.floor(gs * 0.22));
  const labelStyle = new PIXI.TextStyle({
    fill: 0xffffff, fontSize, fontFamily: "Signika, sans-serif",
    stroke: 0x000000, strokeThickness: 2, align: "center",
  });

  const labelsContainer = new PIXI.Container();
  const startCol = Math.floor(bounds.minX / gs);
  const endCol = Math.ceil(bounds.maxX / gs);
  const startRow = Math.floor(bounds.minY / gs);
  const endRow = Math.ceil(bounds.maxY / gs);
  const pieces = _rampPieces(region);

  for (let col = startCol; col < endCol; col++) {
    for (let row = startRow; row < endRow; row++) {
      const cellCx = col * gs + gs / 2;
      const cellCy = row * gs + gs / 2;
      let cellInside = false;
      for (const shape of doc.shapes) {
        if (shape.points?.length >= 6) {
          const pts = shape.points; let c = false;
          for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
            if (((pts[i+1] > cellCy) !== (pts[j+1] > cellCy)) && (cellCx < (pts[j]-pts[i])*(cellCy-pts[i+1])/(pts[j+1]-pts[i+1])+pts[i])) c = !c;
          }
          if (c) { cellInside = true; break; }
        } else if (shape.width != null) {
          const sx = shape.x ?? 0, sy = shape.y ?? 0;
          if (cellCx >= sx && cellCx <= sx + shape.width && cellCy >= sy && cellCy <= sy + shape.height) { cellInside = true; break; }
        }
      }
      if (!cellInside) continue;
      // Same numbers as _computeRampElevation: each separate ramp of the region counts on its own box.
      const t = _rampT(_rampBoundsAt(region, cellCx, cellCy, pieces), ddx, ddy, cellCx, cellCy) ?? 0;
      const elev = _rampSnapFt(botFt + t * (topFt - botFt));
      const label = new TextClass(`${elev}`, labelStyle);
      label.anchor.set(0.5, 0.5);
      label.x = cellCx;
      label.y = cellCy;
      labelsContainer.addChild(label);
    }
  }

  // Mask only for labels.
  const mask = new PIXI.Graphics();
  for (const shape of doc.shapes) {
    if (shape.points?.length >= 6) {
      mask.beginFill(0xffffff); mask.moveTo(shape.points[0], shape.points[1]);
      for (let i = 2; i < shape.points.length; i += 2) mask.lineTo(shape.points[i], shape.points[i + 1]);
      mask.closePath(); mask.endFill();
    } else if (shape.width != null) {
      mask.beginFill(0xffffff); mask.drawRect(shape.x ?? 0, shape.y ?? 0, shape.width, shape.height); mask.endFill();
    }
  }
  labelsContainer.mask = mask;
  labelsContainer.addChild(mask);
  container.addChild(labelsContainer);

  if (region.children != null) region.addChild(container);
  else canvas.regions?.addChild(container);
  region[_RAMP_OVERLAY_KEY] = container;
}

function _clearRampOverlay(region) {
  const old = region[_RAMP_OVERLAY_KEY];
  if (!old) return;
  try { old.parent?.removeChild(old); } catch (_e) {}
  try { old.destroy({ children: true }); } catch (_e) {}
  delete region[_RAMP_OVERLAY_KEY];
}

function _refreshAllOverlays() {
  if (!canvas.regions?.placeables) return;
  for (const r of canvas.regions.placeables) _drawRampArrow(r);
}

// Default visibility of a new region — "layer only" (REGION_VISIBILITY.LAYER = 0).
// ⚠️ Only when visibility did NOT come in the input data: a pasted region (Mass Edit preset) and one
// restored by undoing a deletion already have it configured, and it must not be overwritten.
// In core the field default is LAYER too (common/documents/region.mjs), so for a hand-drawn
// region this line changes nothing — it is there against foreign defaults.
Hooks.on("preCreateRegion", (regionDoc, data) => {
  if (data?.visibility === undefined) regionDoc.updateSource({ visibility: 0 });
});

/* ------------------------------------------------------------------ */
/*  Stairs rotation: rotating the polygon also turns the ramp direction */
/* ------------------------------------------------------------------ */

// Unfold a region shape into a flat array of corner points [x,y, x,y, ...].
// A rectangle is expanded into 4 corners IN THE SAME ORDER (tl, tr, br, bl) that
// Mass Edit uses when converting rect→polygon, so old↔new vertex pairs match
// even when the shape changed type. Ellipse/other — rotation is not computed from points.
function _admShapeCorners(shape) {
  if (!shape) return [];
  if (shape.type === "polygon" && shape.points?.length >= 4) return shape.points.slice();
  if (shape.type === "rectangle" && shape.width != null && shape.height != null) {
    const x = shape.x ?? 0, y = shape.y ?? 0;
    return [x, y, x + shape.width, y, x + shape.width, y + shape.height, x, y + shape.height];
  }
  return [];
}

// Optimal rotation angle old→new (Kabsch method in 2D), radians.
// Returns null if there is too little data OR it is not a rigid rotation (the shape was reworked):
// shift and uniform scale are allowed, non-rigid deformation is rejected.
function _admPolyRotationDelta(oldShapes, newShapes) {
  const n = Math.min(oldShapes?.length ?? 0, newShapes?.length ?? 0);
  const op = [], np = [];
  for (let s = 0; s < n; s++) {
    const oc = _admShapeCorners(oldShapes[s]);
    const nc = _admShapeCorners(newShapes[s]);
    if (oc.length >= 4 && oc.length === nc.length) {
      for (let i = 0; i < oc.length; i++) { op.push(oc[i]); np.push(nc[i]); }
    }
  }
  const m = op.length / 2;
  if (m < 2) return null;

  // Centroids of the old and new point sets.
  let ocx = 0, ocy = 0, ncx = 0, ncy = 0;
  for (let i = 0; i < op.length; i += 2) { ocx += op[i]; ocy += op[i + 1]; ncx += np[i]; ncy += np[i + 1]; }
  ocx /= m; ocy /= m; ncx /= m; ncy /= m;

  // a = Σ(o·n), b = Σ(o×n), r2 = Σ|o|²  (relative to the centroids)
  let a = 0, b = 0, r2 = 0;
  for (let i = 0; i < op.length; i += 2) {
    const ox = op[i] - ocx, oy = op[i + 1] - ocy;
    const nx = np[i] - ncx, ny = np[i + 1] - ncy;
    a += ox * nx + oy * ny;
    b += ox * ny - oy * nx;
    r2 += ox * ox + oy * oy;
  }
  if (r2 < 1) return null;

  const delta = Math.atan2(b, a);
  const scale = Math.sqrt(a * a + b * b) / r2;   // optimal uniform scale

  // Residual after scale·R(delta): a large residual ⇒ the shape was reworked, not rotated.
  const c = Math.cos(delta), s = Math.sin(delta);
  let err2 = 0;
  for (let i = 0; i < op.length; i += 2) {
    const ox = op[i] - ocx, oy = op[i + 1] - ocy;
    const nx = np[i] - ncx, ny = np[i + 1] - ncy;
    const px = scale * (ox * c - oy * s);
    const py = scale * (ox * s + oy * c);
    err2 += (px - nx) * (px - nx) + (py - ny) * (py - ny);
  }
  if (Math.sqrt(err2 / r2) > 0.05) return null;  // RMS residual > 5% of radius — not a rotation

  return delta;
}

// When a stairs polygon is rotated, turn FLAG_DIRECTION by the same angle.
// Mass Edit rotates the region by rewriting shapes (rect is converted to polygon);
// we do this in preUpdate, adding the direction to the same update (atomically).
Hooks.on("preUpdateRegion", (regionDoc, changes) => {
  if (!_regionsOn()) return;
  if (!Array.isArray(changes.shapes)) return;                        // geometry did not change
  if (regionDoc.getFlag(MODULE_ID, FLAG_TYPE) !== "stairs") return;  // only ramps have a direction
  // If the direction is changed explicitly in this same update (via config) — do not interfere.
  if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAG_DIRECTION}`) !== undefined) return;

  const dRad = _admPolyRotationDelta(regionDoc.shapes, changes.shapes);
  if (dRad == null || Math.abs(dRad) < 0.0087) return;               // < 0.5° — shift/scale, not a rotation

  const dir0 = Number(regionDoc.getFlag(MODULE_ID, FLAG_DIRECTION) ?? 0) || 0;
  const r0 = (dir0 * Math.PI) / 180;
  // Direction vector as in _computeRampElevation: v = (-sin, cos).
  const vx = -Math.sin(r0), vy = Math.cos(r0);
  // Rotate by the same matrix R(dRad) that maps the old points to the new ones.
  const c = Math.cos(dRad), s = Math.sin(dRad);
  const nvx = vx * c - vy * s;
  const nvy = vx * s + vy * c;
  // Back to an angle: v = (-sin dir, cos dir) ⇒ dir = atan2(-vx, vy).
  let dir1 = Math.atan2(-nvx, nvy) * 180 / Math.PI;
  dir1 = ((Math.round(dir1) % 360) + 360) % 360;

  foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${FLAG_DIRECTION}`, dir1);
});

/* ------------------------------------------------------------------ */
/*  Wall overlay on regions layer                                      */
/* ------------------------------------------------------------------ */

let _wallOverlay = null;

let _wallsVisible = false;

// Hover tooltip with the aura region name (Alt+W active): a black tooltip at the cursor.
let _auraTipEl = null;
let _auraMoveHandler = null;

/** The adm-daggerheart system's aura config on a region (flags.adm-daggerheart.regionAura), read straight from the
 *  flags. ⚠️ Not getFlag: v13 validates the scope, and in a world on any other system getFlag("adm-daggerheart")
 *  throws — Alt+W broke on every scene with regions. */
function _auraCfg(doc) {
  return doc?.flags?.["adm-daggerheart"]?.regionAura;
}

// Player (non-GM) hold-Alt: reveal visible walls + aura regions. Only the adm-daggerheart system.
let _playerRevealActive = false;
let _playerRevealGfx = null;
let _prMoveHandler = null;

function _drawWallOverlay() {
  _clearWallOverlay();
  if (!canvas.walls?.placeables?.length) return;

  const g = new PIXI.Graphics();
  // With a floor picked in the Levels panel — only that floor's walls (23.09.2026: every floor at once).
  const floor = panelFloor();

  for (const wall of canvas.walls.placeables) {
    const c = wall.document.c;
    if (!c || c.length < 4) continue;
    if (!wallOnFloor(wall.document, floor)) continue;
    const d = wall.document;
    const door = d.door ?? 0;  // 0=none, 1=door, 2=secret
    const move = d.move ?? 0;  // 0=none, 1=normal
    const sight = d.sight ?? 0; // 0=none, 1=normal
    const light = d.light ?? 0; // 0=none, 1=normal

    let color, alpha = 0.6, width = 2;
    if (door === 2) { color = 0xff00ff; width = 3; }        // secret door — magenta
    else if (door === 1) { color = 0x00ffff; width = 3; }   // door — cyan
    else if (move && sight) { color = 0xffaa00; }            // wall (move+sight) — orange
    else if (move && !sight) { color = 0x00ccff; alpha = 0.4; } // terrain (move only) — light blue
    else if (!move && sight) { color = 0x4488ff; }           // ethereal (sight only) — blue
    else { color = 0x888888; alpha = 0.3; }                  // invisible — gray

    g.lineStyle(width, color, alpha);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
  }

  g.eventMode = "none";
  canvas.interface.addChild(g);
  _wallOverlay = g;
}

function _clearWallOverlay() {
  if (!_wallOverlay) return;
  try { _wallOverlay.parent?.removeChild(_wallOverlay); } catch (_e) {}
  try { _wallOverlay.destroy(); } catch (_e) {}
  _wallOverlay = null;
}

/* ── Grid while Alt+W is held ──────────────────────────────────────────────
 * Walls and regions are hard to read without a grid, so for the duration of the
 * inspection we raise it to a workable opacity.
 *
 * ⚠️ LOCALLY, without writing to the document. `scene.grid.alpha` is a scene field: an
 * edit would go out over the socket to everyone, and the grid would flicker for players
 * from someone else's Alt+W. We change only the canvas rendering (`initializeMesh`), locally.
 * ⚠️ Threshold: a grid brighter than 0.4 is not our concern, the GM meant it that way. We
 * touch only what is dimmer.                                                    */
const ADM_GRID_ALPHA = 0.4;
let _admGridForced = false;

function _admShowGrid() {
  try {
    const layer = canvas?.interface?.grid;
    const grid = canvas?.grid;
    if (!layer || !grid) return;
    // Nothing to show on a gridless scene.
    if (grid.type === CONST.GRID_TYPES.GRIDLESS) return;
    if (Number(grid.alpha ?? 1) >= ADM_GRID_ALPHA) return;
    layer.initializeMesh({
      style: grid.style, thickness: grid.thickness, color: grid.color,
      alpha: ADM_GRID_ALPHA,
    });
    _admGridForced = true;
  } catch (e) { console.warn("[adm-levels] grid show", e); }
}

/** Restore the grid's real look. We do not remember the value — we re-read it from
 *  the scene: while the walls were shown, the GM may have adjusted the settings. */
function _admRestoreGrid() {
  if (!_admGridForced) return;
  _admGridForced = false;
  try { canvas?.interface?.grid?.initializeMesh(canvas.grid); }
  catch (e) { console.warn("[adm-levels] grid restore", e); }
}

function _toggleWalls() {
  // Toggle state comes from _wallsVisible, NOT from _wallOverlay: on a scene with no walls
  // _drawWallOverlay exits early (_wallOverlay stays null), but aura regions/hover
  // still need to be switchable off by a repeated Alt+W.
  if (_wallsVisible) {
    _clearWallOverlay();
    // Hide adm-levels regions.
    _setRegionsVisibility(0);
    _stopAuraHover();
    _admRestoreGrid();
    _wallsVisible = false;
  } else {
    _drawWallOverlay();
    // Show adm-levels regions via Foundry's native rendering.
    _setRegionsVisibility(1);
    _startAuraHover();
    _admShowGrid();
    _wallsVisible = true;
    _altWFloorKey = _floorKey(panelFloor());
  }
  // Event for sub-modules for which Alt+W = "show the map's service markup"
  // (Levels floor panel — tools/levels-follow-token.mjs). Only a signal here:
  // the feature itself lives in the tool and is gated by its own checkbox.
  Hooks.callAll("admLevelsWallsToggled", _wallsVisible);
  // The floor panel is opened BY that signal, after the markup above was drawn, and gets its floor
  // only after an awaited scene update (levels/scripts/ui.js activateListeners) — no event of its own.
  if (_wallsVisible) { setTimeout(_altWRefresh, 400); setTimeout(_altWRefresh, 1200); }
}

/* ── Alt+W follows the Levels panel floor ──────────────────────────────────
 * With a floor picked in the Levels panel the markup shows only that floor's walls and regions
 * (23.09.2026: every floor at once). A level click fires levelsUiChangeLevel; closing the panel
 * drops the floor (everything again). Redrawn only when the floor really changed.            */
let _altWFloorKey = "";
const _floorKey = (f) => (f ? `${f.lo}|${f.hi}` : "");

function _altWRefresh() {
  if (!_wallsVisible) return;
  const key = _floorKey(panelFloor());
  if (key === _altWFloorKey) return;
  _altWFloorKey = key;
  _drawWallOverlay();
  _setRegionsVisibility(1);
}

Hooks.on("levelsUiChangeLevel", () => _altWRefresh());
Hooks.on("closeLevelsUI", () => setTimeout(_altWRefresh, 0));   // rangeEnabled is reset inside close()

function _setRegionsVisibility(vis) {
  // visibility is a Region document field (synced to everyone). Only the GM can write it;
  // for a player the canvasReady call gave "lacks permission to update Region". The GM update
  // reaches all clients anyway, the player does not need to write it himself.
  if (!game.user?.isGM) return;
  if (!canvas.scene?.regions) return;
  // With a floor picked in the Levels panel only that floor's regions are shown; a region of another
  // floor shown earlier (the floor was switched) is hidden again (23.09.2026: every floor at once).
  const floor = vis === 1 ? panelFloor() : null;
  const updates = [];
  for (const doc of canvas.scene.regions) {
    // Show/hide adm-levels elevation regions AND the system's aura regions
    // (flags.adm-daggerheart.regionAura.enabled). Both render natively in their OWN color.
    const _isHeight = !!doc.getFlag(MODULE_ID, FLAG_TYPE);
    const _isAura = !!_auraCfg(doc)?.enabled;
    if (!_isHeight && !_isAura) continue;
    // Alt+W moves visibility only between 0 (Layer/hidden) and 1 (Gamemaster/shown to us).
    // Value 2 (Always — the GM deliberately showed the region to players) is NOT touched: otherwise
    // the reset on canvasReady/switch-off would wipe that choice for aura regions (and elevations).
    const cur = Number(doc.visibility ?? 0);
    const show = vis === 1 && regionOnFloor(doc, floor);
    if (show) { if (cur === 0) updates.push({ _id: doc.id, visibility: 1 }); }
    else      { if (cur === 1) updates.push({ _id: doc.id, visibility: 0 }); }
  }
  if (updates.length) canvas.scene.updateEmbeddedDocuments("Region", updates);
}

/* ── Hover tooltip with the aura region name (only while Alt+W is active) ───────
 *  When the cursor hovers a region with an enabled aura, show a black tooltip
 *  with the region name at the cursor. 2D hit test (region.testPoint without elevation). */
function _ensureAuraTip() {
  if (_auraTipEl) return _auraTipEl;
  const el = document.createElement("div");
  el.className = "adm-levels-aura-tip";
  el.style.cssText = "position:fixed;background:#000;color:#fff;padding:3px 8px;border-radius:3px;"
    + "font-size:12px;line-height:1.3;pointer-events:none;z-index:100001;white-space:nowrap;"
    + "box-shadow:0 1px 4px rgba(0,0,0,.6);display:none;";
  document.body.appendChild(el);
  _auraTipEl = el;
  return el;
}

function _auraRegionAt(worldX, worldY) {
  // The GM's Levels panel floor: an aura of another floor under the cursor has no name to show.
  // A player has no panel — the floor is null and everything counts, as before.
  const floor = panelFloor();
  for (const region of (canvas?.regions?.placeables ?? [])) {
    const cfg = _auraCfg(region.document);
    if (!cfg?.enabled) continue;
    if (!regionOnFloor(region.document, floor)) continue;
    let inside = false;
    try {
      inside = !!region.testPoint?.({ x: worldX, y: worldY })
            || !!region.testPoint?.({ x: worldX, y: worldY, elevation: 0 });
    } catch (_e) {}
    if (inside) return region;
  }
  return null;
}

// Can the CURRENT user see the point (fog + lighting/darkness). Fail-safe: false
// (do not reveal when the API is unavailable — the feature is behind the system gate anyway).
function _playerCanSee(pt, tol = 8) {
  try {
    const vis = canvas?.effects?.visibility;
    if (!vis?.testVisibility) return false;
    return !!vis.testVisibility(pt, { tolerance: tol });
  } catch (_e) { return false; }
}

/* ── Speeding up wall reveal (player's Alt) ───────────────────────────────
 * ⚠️ Core testVisibility is an EXPENSIVE call: at tolerance:8 it expands NINE
 * test points, creates an object with a Map for each (visibility.mjs, _createVisibilityTestConfig),
 * filters vision sources and runs the detection modes. A three-cell wall is
 * ~10 calls, i.e. ~90 checks; on a map with hundreds of walls the player's client froze
 * for 1–2 seconds when pressing Alt (complaint from a session).
 * Neither trick below changes semantics — they just do not ask core questions whose
 * answer is known in advance. */

/** Memo for a single build pass: the key is the coordinates rounded to the pixel.
 *  The test tolerance is 8px anyway, so a sub-pixel difference decides nothing, and
 *  dungeon walls share endpoints en masse — many hits. */
let _prSeeMemo = null;
function _playerCanSeeMemo(x, y) {
  if (!_prSeeMemo) return _playerCanSee({ x, y });
  const k = (x | 0) + ":" + (y | 0);
  let v = _prSeeMemo.get(k);
  if (v === undefined) { v = _playerCanSee({ x, y }); _prSeeMemo.set(k, v); }
  return v;
}

/**
 * Bounding rectangles of all shapes INSIDE which a point can possibly be
 * visible: LOS of vision sources + shapes of light sources that grant vision. A point outside
 * them is guaranteed to fail testVisibility (every branch there requires hitting
 * one of these polygons) — so the wall can be discarded without asking core.
 * Bounds, not the polygons themselves: the cull is conservative (an extra wall is kept, a needed
 * one is never lost), but the check is four comparisons.
 */
function _prVisibilityRects() {
  const rects = [];
  const _push = (poly) => {
    const pts = poly?.points;
    if (!Array.isArray(pts) || pts.length < 6) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    rects.push({ minX, minY, maxX, maxY });
  };
  const _iter = (coll) => {
    if (!coll) return [];
    return (typeof coll.values === "function") ? coll.values() : coll;
  };
  for (const s of _iter(canvas.effects?.visionSources)) {
    if (!s || s.active === false) continue;
    _push(s.los ?? s.shape ?? s.fov);
  }
  for (const s of _iter(canvas.effects?.lightSources)) {
    if (!s || s.active === false || !s.data?.vision) continue;
    _push(s.shape ?? s.los);
  }
  return rects;
}

/** Does the segment (with margin pad) intersect at least one visibility bounding box. */
function _prSegNearVisible(x1, y1, x2, y2, rects, pad) {
  if (!rects.length) return false;
  const sMinX = Math.min(x1, x2) - pad, sMaxX = Math.max(x1, x2) + pad;
  const sMinY = Math.min(y1, y2) - pad, sMaxY = Math.max(y1, y2) + pad;
  for (const r of rects) {
    if (sMaxX < r.minX || sMinX > r.maxX) continue;
    if (sMaxY < r.minY || sMinY > r.maxY) continue;
    return true;
  }
  return false;
}

// Shared display of the aura region name tooltip under the cursor. requireVisible=true (player) —
// show only if the point is actually visible (otherwise do not reveal the name in fog/darkness).
function _updateAuraTip(clientX, clientY, requireVisible) {
  const tip = _ensureAuraTip();
  const view = canvas?.app?.view;
  if (!view || !canvas?.stage) { tip.style.display = "none"; return; }
  const rect = view.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    tip.style.display = "none"; return;
  }
  let world;
  try { world = canvas.stage.toLocal(new PIXI.Point(clientX - rect.left, clientY - rect.top)); }
  catch (_e) { tip.style.display = "none"; return; }
  if (requireVisible && !_playerCanSee(world)) { tip.style.display = "none"; return; }
  const region = _auraRegionAt(world.x, world.y);
  if (!region) { tip.style.display = "none"; return; }
  const cfg = _auraCfg(region.document);
  const name = String(region.document?.name ?? "").trim()
    || String(cfg?.auraName ?? "").trim()
    || game.i18n.localize("ADM_LEVELS.ui.regionAura");
  tip.textContent = name;
  tip.style.left = (clientX + 14) + "px";
  tip.style.top = (clientY + 14) + "px";
  tip.style.display = "";
}
function _onAuraHoverMove(e) { _updateAuraTip(e.clientX, e.clientY, false); }       // GM: no visibility gate
function _onAuraHoverMovePlayer(e) { _updateAuraTip(e.clientX, e.clientY, true); }  // Player: visible only

function _startAuraHover() {
  if (_auraMoveHandler) return;
  _auraMoveHandler = _onAuraHoverMove;
  window.addEventListener("pointermove", _auraMoveHandler);
}

function _stopAuraHover() {
  if (_auraMoveHandler) {
    window.removeEventListener("pointermove", _auraMoveHandler);
    _auraMoveHandler = null;
  }
  if (_auraTipEl) _auraTipEl.style.display = "none";
}

Hooks.on("canvasReady", async () => {
  _refreshAllOverlays();
  _clearWallOverlay();
  _wallOverlay = null;
  _wallsVisible = false;
  // Reset regions to hidden (Alt+W state doesn't persist across reload).
  _setRegionsVisibility(0);
  _stopAuraHover();
  // The canvas redrew the grid itself from the scene settings — just clear the mark so
  // the next Alt+W does not think we have already raised it.
  _admGridForced = false;
  // Walls/doors bound to tiles — synchronize (GM only).
  if (game.user?.isGM) {
    for (const wallDoc of (canvas.scene?.walls ?? [])) {
      if (wallDoc.getFlag(MODULE_ID, FLAG_TILE_BIND)) {
        try { await _applyWallBindState(wallDoc); } catch (e) { console.warn("[adm-levels] wall bind init", e); }
      }
    }
  }
});

// Alt+W toggle.
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.code === "KeyW" && !e.ctrlKey && !e.shiftKey && game.user?.isGM) {
    e.preventDefault();
    _toggleWalls();
  }
});

/* ── Player (non-GM) holds Alt → while held, show visible wall lines and outlines of
 *  aura regions (not terrain ones), clipped by fog/darkness (testVisibility). Hovering
 *  an aura region shows its name at the cursor. ONLY the adm-daggerheart system. ────── */
function _clearPlayerReveal() {
  if (!_playerRevealGfx) return;
  try { _playerRevealGfx.parent?.removeChild(_playerRevealGfx); } catch (_e) {}
  try { _playerRevealGfx.destroy({ children: true }); } catch (_e) {}
  _playerRevealGfx = null;
}

// Region color → number for PIXI (Color is a Number subclass; a "#rrggbb" string is parsed).
function _regionColorNum(doc) {
  const c = doc?.color;
  if (c == null) return 0xffff00;
  if (typeof c === "number") return c;
  const n = Number(c); // Color is a Number subclass; valueOf → number (incl. 0 = black)
  if (Number.isFinite(n) && n >= 0) return n;
  if (typeof c === "string") { const p = parseInt(c.replace(/^#/, ""), 16); if (Number.isFinite(p)) return p; }
  return 0xffff00;
}

// Draw ONLY the visible sub-segments of the segment (sampling + the player's testVisibility).
function _drawVisibleSeg(g, x1, y1, x2, y2, color, width, alpha, step) {
  g.lineStyle(width, color, alpha);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len <= 0) { if (_playerCanSeeMemo(x1, y1)) { g.moveTo(x1, y1); g.lineTo(x2, y2); } return; }
  const n = Math.max(1, Math.ceil(len / step));
  let px = x1, py = y1, pv = _playerCanSeeMemo(x1, y1);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
    const cv = _playerCanSeeMemo(cx, cy);
    if (pv && cv) { g.moveTo(px, py); g.lineTo(cx, cy); }  // both ends of the sub-segment visible → draw
    px = cx; py = cy; pv = cv;
  }
}

// Region shape polygons (for PIXI fill): rect/polygon/ellipse/circle with rotation.
// Holes are not filled (rare; acceptable). Points are absolute (as in doc.shapes).
function _regionPolys(doc) {
  const polys = [];
  for (const shape of (doc?.shapes ?? [])) {
    if (shape?.hole) continue;
    const type = String(shape?.type ?? "");
    if (type === "polygon" || Array.isArray(shape?.points)) {
      if (Array.isArray(shape.points) && shape.points.length >= 6) polys.push(shape.points.slice());
    } else if (type === "rectangle" || shape?.width != null) {
      const x = shape.x ?? 0, y = shape.y ?? 0, w = shape.width ?? 0, h = shape.height ?? 0;
      const rot = (Number(shape.rotation ?? 0) || 0) * Math.PI / 180, cx = x + w / 2, cy = y + h / 2;
      const pts = [];
      for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        if (!rot) { pts.push(px, py); }
        else { const dx = px - cx, dy = py - cy; pts.push(cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)); }
      }
      polys.push(pts);
    } else if (type === "ellipse" || type === "circle" || shape?.radius != null || shape?.radiusX != null) {
      const cx = shape.x ?? 0, cy = shape.y ?? 0;
      const rx = Number(shape.radiusX ?? shape.radius ?? 0) || 0, ry = Number(shape.radiusY ?? shape.radius ?? 0) || 0;
      const rot = (Number(shape.rotation ?? 0) || 0) * Math.PI / 180, pts = [], N = 48;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2; let ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
        if (rot) { const nx = ex * Math.cos(rot) - ey * Math.sin(rot), ny = ex * Math.sin(rot) + ey * Math.cos(rot); ex = nx; ey = ny; }
        pts.push(cx + ex, cy + ey);
      }
      polys.push(pts);
    }
  }
  return polys;
}

// A region is visible to the player if AT LEAST ONE of its interior points is currently visible (not
// entirely in fog/darkness). Coarse sampling over the bbox — cheap (a few dozen checks).
function _regionPartlyVisible(doc, region) {
  const b = (doc?.bounds && doc.bounds.width > 0) ? doc.bounds : region?.bounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) return false;
  const gs = Number(canvas.grid?.size) || 100;
  const stepX = Math.max(gs / 2, b.width / 16), stepY = Math.max(gs / 2, b.height / 16);
  const inside = (x, y) => { try { return !!region.testPoint?.({ x, y }) || !!region.testPoint?.({ x, y, elevation: 0 }); } catch (_e) { return false; } };
  for (let y = b.y + stepY / 2; y < b.y + b.height; y += stepY) {
    for (let x = b.x + stepX / 2; x < b.x + b.width; x += stepX) {
      if (inside(x, y) && _playerCanSeeMemo(x, y)) return true;
    }
  }
  return false;
}

// The player's vision mask = the union of the LOS polygons of his vision sources (bounded by
// SIGHT WALLS). We clip the region fill with it so it does not spill past fog/walls.
// null if there are no sources (global light / no token) → the fill is not clipped by a mask.
function _buildVisionMask() {
  const srcs = canvas.effects?.visionSources ?? canvas.visionSources;
  if (!srcs) return null;
  const iter = (typeof srcs.values === "function") ? srcs.values() : srcs;
  const m = new PIXI.Graphics();
  m.beginFill(0xffffff, 1);
  let any = false;
  for (const src of iter) {
    if (!src || src.active === false) continue;
    const poly = src.los ?? src.shape ?? src.fov;
    const pts = poly?.points;
    if (Array.isArray(pts) && pts.length >= 6) { m.drawPolygon(pts); any = true; }
  }
  m.endFill();
  if (!any) { try { m.destroy(); } catch (_e) {} return null; }
  return m;
}

function _buildPlayerReveal() {
  _clearPlayerReveal();
  if (!canvas?.ready) return;
  const container = new PIXI.Container();
  container.eventMode = "none";
  const gs = Number(canvas.grid?.size) || 100;
  const step = Math.max(16, gs / 3);
  // The memo and visibility bounds live for exactly one build pass: vision changes
  // from frame to frame, they must not be cached between Alt presses.
  _prSeeMemo = new Map();
  const _visRects = _prVisibilityRects();

  // 1) Aura regions (not terrain ones) — a solid semi-transparent fill of the shape in the region's
  //    color (no outline), UNDER the walls. The "partly visible" gate discards auras
  //    entirely in fog/darkness; the vision mask (LOS) clips per-pixel by sight walls.
  const gFill = new PIXI.Graphics();
  for (const region of (canvas.regions?.placeables ?? [])) {
    const doc = region.document;
    if (!_auraCfg(doc)?.enabled) continue;                                   // auras only
    if (doc.getFlag(MODULE_ID, FLAG_TYPE)) continue;                         // terrain ones are not shown
    if (!_regionPartlyVisible(doc, region)) continue;                        // entirely in fog/darkness — hidden
    gFill.lineStyle(0);
    gFill.beginFill(_regionColorNum(doc), 0.3);
    for (const pts of _regionPolys(doc)) gFill.drawPolygon(pts);
    gFill.endFill();
  }
  const vmask = _buildVisionMask();
  if (vmask) { gFill.mask = vmask; gFill.addChild(vmask); } // clip the fill by vision
  container.addChild(gFill);

  // 2) Walls — visible sub-segments, ON TOP of the fill. Secret doors are NOT revealed (drawn as a regular wall).
  const gWall = new PIXI.Graphics();
  for (const wall of (canvas.walls?.placeables ?? [])) {
    const c = wall.document?.c;
    if (!Array.isArray(c) || c.length < 4) continue;
    // ⚠️ Cull BEFORE the expensive test: a wall whose segment touches no visibility
    // bounding box cannot yield a single visible sub-segment. On a map with many
    // walls where vision covers a small part of the scene, this removes the vast
    // majority of testVisibility calls — exactly what made Alt hang.
    if (!_prSegNearVisible(c[0], c[1], c[2], c[3], _visRects, 8)) continue;
    const isDoor = (wall.document.door ?? 0) === 1; // 1=regular door (already visible to the player); 2=secret — do not reveal
    const color = isDoor ? 0x00ffff : 0xffaa00;
    const width = isDoor ? 3 : 2;
    _drawVisibleSeg(gWall, c[0], c[1], c[2], c[3], color, width, 0.7, step);
  }
  container.addChild(gWall);

  container.eventMode = "none";
  (canvas.interface ?? canvas.stage)?.addChild(container);
  _playerRevealGfx = container;
  _prSeeMemo = null;   // the memo lives only inside the pass — otherwise it would show yesterday's vision
}

function _prDeactivate() {
  _playerRevealActive = false;
  _clearPlayerReveal();
  if (_prMoveHandler) { window.removeEventListener("pointermove", _prMoveHandler); _prMoveHandler = null; }
  if (_auraTipEl) _auraTipEl.style.display = "none";
}

function _prIsAltKey(ev) { return ev.key === "Alt" || ev.code === "AltLeft" || ev.code === "AltRight"; }
function _prOnKeyDown(ev) {
  if (!_prIsAltKey(ev) || _playerRevealActive) return; // guard against keydown auto-repeat
  _playerRevealActive = true;
  _buildPlayerReveal();
  if (!_prMoveHandler) { _prMoveHandler = _onAuraHoverMovePlayer; window.addEventListener("pointermove", _prMoveHandler); }
}
function _prOnKeyUp(ev) { if (_prIsAltKey(ev)) _prDeactivate(); }
function _prOnBlur() { _prDeactivate(); }

/* TEMPORARILY DISABLED. Players no longer highlight walls by holding Alt.
 * To bring it back — set true. The feature code below is untouched. */
const ADM_PLAYER_ALT_REVEAL = false;

Hooks.once("ready", () => {
  if (!ADM_PLAYER_ALT_REVEAL) return;                   // <- temporary disable
  if (game.user?.isGM) return;                          // the feature is for players only
  if (game.system?.id !== "adm-daggerheart") return;    // and only with our system
  document.addEventListener("keydown", _prOnKeyDown, true);
  document.addEventListener("keyup", _prOnKeyUp, true);
  window.addEventListener("blur", _prOnBlur);
});
Hooks.on("canvasReady", () => { _prDeactivate(); }); // scene change — reset

/* ====================================================================
 *  Alt+RMB on a tile → a floating panel with a visibility toggle.
 *  Works in any layer (not only the Tile Layer).
 * ==================================================================== */

let _tileTogglePanel = null;

function _hideTileTogglePanel() {
  if (_tileTogglePanel) {
    try { _tileTogglePanel.remove(); } catch (_) {}
    _tileTogglePanel = null;
  }
  document.removeEventListener("mousedown", _onDocClickHidePanel, true);
  document.removeEventListener("keydown", _onEscHidePanel, true);
}
function _onDocClickHidePanel(ev) {
  if (_tileTogglePanel && !_tileTogglePanel.contains(ev.target)) _hideTileTogglePanel();
}
function _onEscHidePanel(ev) {
  if (ev.key === "Escape") _hideTileTogglePanel();
}

function _findTopmostTileAt(x, y) {
  const tiles = canvas.tiles?.placeables ?? [];
  const sorted = [...tiles].sort((a, b) => (b.document?.sort ?? 0) - (a.document?.sort ?? 0));
  for (const t of sorted) {
    const d = t.document;
    if (!d) continue;
    if (x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height) return d;
  }
  return null;
}

function _showTileTogglePanel(tileDoc, screenX, screenY) {
  _hideTileTogglePanel();
  const isHidden = !!tileDoc.hidden;
  const label = game.i18n.localize(isHidden ? "ADM_LEVELS.tile.show" : "ADM_LEVELS.tile.hide");
  const icon  = isHidden ? "fa-eye"        : "fa-eye-slash";
  const state = game.i18n.localize(isHidden ? "ADM_LEVELS.tile.hidden" : "ADM_LEVELS.tile.visible");

  const panel = document.createElement("div");
  panel.className = "adm-levels-tile-toggle";
  panel.style.cssText = [
    "position:fixed",
    `left:${screenX}px`, `top:${screenY}px`,
    "background:rgba(20,20,20,0.95)",
    "border:1px solid #888", "border-radius:4px",
    "padding:6px 8px", "z-index:10000", "color:#eee",
    "font-size:12px", "box-shadow:0 4px 12px rgba(0,0,0,0.6)",
    "display:flex", "flex-direction:column", "gap:6px", "min-width:170px",
  ].join(";");
  panel.innerHTML = `
    <div style="opacity:.7;font-size:11px;">Tile ${tileDoc.id.slice(0,8)}… (${state})</div>
    <button type="button" data-toggle
      style="padding:5px 9px;display:flex;align-items:center;gap:8px;cursor:pointer;background:#333;border:1px solid #555;color:#eee;border-radius:3px;">
      <i class="fa-solid ${icon}"></i><span>${label}</span>
    </button>
    <button type="button" data-edit
      style="padding:4px 8px;display:flex;align-items:center;gap:8px;cursor:pointer;background:transparent;border:1px solid #555;color:#bbb;border-radius:3px;font-size:11px;">
      <i class="fa-solid fa-pen-to-square"></i><span>${game.i18n.localize("ADM_LEVELS.tile.openSettings")}</span>
    </button>
  `;
  document.body.appendChild(panel);
  _tileTogglePanel = panel;

  // Shift if it goes past the screen edge
  const rect = panel.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) panel.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight - 8) panel.style.top = `${window.innerHeight - rect.height - 8}px`;

  panel.querySelector("[data-toggle]").addEventListener("click", async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    try { await tileDoc.update({ hidden: !isHidden }); }
    catch (e) { console.warn("[adm-levels] toggle tile", e); }
    _hideTileTogglePanel();
  });
  panel.querySelector("[data-edit]").addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    try { tileDoc.sheet?.render(true); } catch (_) {}
    _hideTileTogglePanel();
  });

  // Close on outside click / Esc — deferred so we do not catch the same click that opened it.
  setTimeout(() => {
    document.addEventListener("mousedown", _onDocClickHidePanel, true);
    document.addEventListener("keydown", _onEscHidePanel, true);
  }, 50);
}

// Alt+RMB on a tile → floating toggle visibility panel.
// We used to listen to `canvas.app.stage.on("rightdown")`, but in Foundry v13 (PIXI v7)
// federated events on app.stage do not always deliver `rightdown` (events are swallowed
// by active layers or Foundry's context menu intercepts earlier). Switched to
// a DOM-level `contextmenu` in the capture phase — guaranteed to fire for
// every RMB click on the canvas, whatever the active layer is.
if (!globalThis.__admLevelsTileToggleDocHooked) {
  globalThis.__admLevelsTileToggleDocHooked = true;
  document.addEventListener("contextmenu", (ev) => {
    if (!game.user?.isGM) return;
    if (!ev.altKey) return;
    if (!canvas?.ready || !canvas.app?.view) return;
    // Ignore clicks outside the canvas (on chat, sidebar, dialogs).
    const view = canvas.app.view;
    if (!(ev.target === view || view.contains?.(ev.target))) return;
    // client → world coords. canvas.app.view has a CSS rect; canvas.stage is a
    // PIXI Container with a scale/translate transform for the current pan/zoom.
    const rect = view.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    let worldPos;
    try {
      worldPos = canvas.stage.toLocal(new PIXI.Point(sx, sy));
    } catch (e) { console.warn("[adm-levels] alt+rmb toLocal", e); return; }
    if (!worldPos) return;
    const tile = _findTopmostTileAt(worldPos.x, worldPos.y);
    if (!tile) return;
    // Suppress the Foundry / PIXI context menu ONLY when a tile was found — otherwise
    // do not block the standard RMB handling (e.g. the token context menu).
    ev.preventDefault();
    ev.stopPropagation();
    _showTileTogglePanel(tile, ev.clientX, ev.clientY);
  }, true); // capture phase — before Foundry handlers
}
Hooks.on("refreshRegion", (r) => _drawRampArrow(r));
Hooks.on("updateRegion", () => setTimeout(_refreshAllOverlays, 100));

// The old `levels` module runs a 3D collision check on elevation change
// and with background_elevation < 0 (used by adm-levels for pits) it falsely fires
// its "movement blocked by a wall or ceiling" notification.
// `levels` has a built-in bypass `flags.levels.stairUpdate` — we set it
// so it skips its check. adm-levels manages elevation itself.
Hooks.on("preUpdateToken", (tokenDoc, updates) => {
  if (!("elevation" in (updates ?? {}))) return;
  if (!game.modules.get("levels")?.active) return;
  foundry.utils.setProperty(updates, "flags.levels.stairUpdate", true);
});
// Tile visibility changed — revisit region overlays and recompute
// elevation/water for tokens standing in those regions.
Hooks.on("updateTile", async (tileDoc, changes) => {
  if (!("hidden" in (changes ?? {}))) return;
  const scene = tileDoc?.parent;
  if (!scene || scene.id !== canvas.scene?.id) return;
  // Find the regions whose tileBindId === tileDoc.id.
  const boundRegions = [];
  for (const regionDoc of (canvas.scene?.regions ?? [])) {
    if (regionDoc.getFlag(MODULE_ID, FLAG_TILE_BIND) === tileDoc.id) {
      boundRegions.push(regionDoc);
    }
  }
  // Bound walls — update their move/sight via _applyWallBindState (GM only).
  if (game.user?.isGM) {
    for (const wallDoc of (canvas.scene?.walls ?? [])) {
      if (wallDoc.getFlag(MODULE_ID, FLAG_TILE_BIND) === tileDoc.id) {
        try { await _applyWallBindState(wallDoc); } catch (e) { console.warn("[adm-levels] wall bind sync", e); }
      }
    }
  }
  if (!boundRegions.length) return;

  // Arrows/visuals — update on all clients.
  for (const regionDoc of boundRegions) {
    const regionObj = regionDoc.object ?? canvas.regions?.get(regionDoc.id);
    if (regionObj) _drawRampArrow(regionObj);
  }

  // Recomputing elevation/water — GM only (he writes the TokenDocument).
  if (!game.user?.isGM) return;
  // A small delay so tile.hidden has time to apply.
  await new Promise(res => setTimeout(res, 50));

  const seen = new Set();
  for (const regionDoc of boundRegions) {
    const regionObj = regionDoc.object ?? canvas.regions?.get(regionDoc.id);
    if (!regionObj) continue;
    for (const tok of canvas.tokens?.placeables ?? []) {
      const td = tok.document;
      if (!td || seen.has(td.id)) continue;
      const cx = tok.x + tok.w / 2;
      const cy = tok.y + tok.h / 2;
      const elev = Number(td.elevation ?? 0);
      // Is the token inside this region (XY). Try with the current elev and with 0.
      let inside = false;
      try {
        inside = !!regionObj.testPoint?.({ x: cx, y: cy, elevation: elev });
      } catch (_) {}
      if (!inside) {
        try { inside = !!regionObj.testPoint?.({ x: cx, y: cy, elevation: 0 }); } catch (_) {}
      }
      if (!inside) continue;
      seen.add(td.id);
      await _refreshTokenForRegionChange(td);
    }
  }
});

/** Recompute the token's elevation and water status when a region appears/disappears.
 *  Walk/burrow: snap to the region surface (or 0).
 *  Fly/climb: raise ONLY if the new surface is higher than the current elevation
 *  (a creature cannot end up inside/under a platform). We do not snap downward. */
async function _refreshTokenForRegionChange(tokenDoc) {
  const action = String(tokenDoc.movementAction ?? "walk");
  const gs = Number(canvas.grid?.size) || 100;
  const cx = (tokenDoc.x ?? 0) + ((tokenDoc.width ?? 1) * gs) / 2;
  const cy = (tokenDoc.y ?? 0) + ((tokenDoc.height ?? 1) * gs) / 2;
  const elev = Number(tokenDoc.elevation ?? 0);
  const computed = _elevationAtXY(cx, cy, elev);

  // teleport+animation:false — so Foundry does not treat this as movement (does not deduct movement in combat).
  const updOpts = { animation: false, teleport: true };
  if (action === "fly" || action === "climb") {
    // Raise only: if a region "grew" under/around a flying/climbing token and ended up higher — raise it.
    if (computed != null && computed > elev) {
      await tokenDoc.update({ elevation: computed }, updOpts);
    }
  } else {
    // Walk/burrow — the usual snap. null = "ground" (no active region).
    const targetElev = (computed != null) ? computed : 0;
    if (targetElev !== elev) {
      await tokenDoc.update({ elevation: targetElev }, updOpts);
    }
  }
  // Water-sync — applies/removes swim/inWater as needed.
  try { await _syncWaterStateForToken(tokenDoc); } catch (e) { console.warn("[adm-levels] water sync", e); }
}

/* ====================================================================
 *  Binding walls (Wall) to tile visibility
 *  Tile visible → wall "active" (original move/sight).
 *  Tile hidden → wall "inactive" (move/sight = NONE), passable through.
 *  Inversion flips the logic. The original state is saved when binding.
 * ==================================================================== */

const FLAG_WALL_ORIG = "wallOrig"; // { move, sight, light, sound } — state at binding time

function _isDoor(wallDoc) {
  return Number(wallDoc.door ?? 0) !== (CONST.WALL_DOOR_TYPES?.NONE ?? 0);
}

/** Apply the current binding state.
 *  Door wall → controls the tile's visibility (open→viewer, closed→hidden).
 *  Regular wall → follows the tile's visibility (move/sight toggle NORMAL↔NONE).
 *  Inversion flips the mapping. */
async function _applyWallBindState(wallDoc) {
  if (!game.user?.isGM) return;
  const tileId = wallDoc.getFlag(MODULE_ID, FLAG_TILE_BIND);
  if (!tileId) return;
  const scene = wallDoc.parent ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  if (!tile) return;
  const invert = !!wallDoc.getFlag(MODULE_ID, FLAG_TILE_INVERT);

  if (_isDoor(wallDoc)) {
    // "Door controls the tile" mode.
    // First restore the wall's own move/sight to the original — if they were previously
    // overwritten in "regular wall" mode, they must roll back (the door controls passage itself).
    const orig = wallDoc.getFlag(MODULE_ID, FLAG_WALL_ORIG);
    if (orig) {
      const u = {};
      if (wallDoc.move  !== orig.move)  u.move  = orig.move;
      if (wallDoc.sight !== orig.sight) u.sight = orig.sight;
      if (wallDoc.light !== orig.light) u.light = orig.light;
      if (wallDoc.sound !== orig.sound) u.sound = orig.sound;
      if (Object.keys(u).length) await wallDoc.update(u, { admLevelsBindSync: true });
    }
    // Tile visibility = open ⊕ invert.
    const ds = Number(wallDoc.ds ?? 0);
    const open = ds === (CONST.WALL_DOOR_STATES?.OPEN ?? 1);
    const shouldVisible = invert ? !open : open;
    const targetHidden = !shouldVisible;
    // Hide COMPLETELY (from players and in the GM's eyes). `hidden` alone is not enough: Foundry draws a hidden
    // tile for the GM at 50% (tile.mjs: mesh.alpha = targetAlpha × 0.5). We also zero document.alpha:
    // final alpha = 0.5 × unoccludedAlpha(=document.alpha) = 0 → the GM does not see it either. `hidden` stays —
    // it hides the tile from players (isVisible = !hidden || isGM) and feeds the region binding (reads tile.hidden).
    const targetAlpha = shouldVisible ? 1 : 0;
    const upd = {};
    if (!!tile.hidden !== targetHidden) upd.hidden = targetHidden;
    if (Number(tile.alpha ?? 1) !== targetAlpha) upd.alpha = targetAlpha;
    if (Object.keys(upd).length) await tile.update(upd);
    return;
  }

  // "Regular wall follows the tile" mode.
  const tileHidden = !!tile.hidden;
  const should = invert ? tileHidden : !tileHidden;

  const orig = wallDoc.getFlag(MODULE_ID, FLAG_WALL_ORIG);
  const NORMAL_MOVE  = CONST.WALL_MOVEMENT_TYPES?.NORMAL ?? 20;
  const NONE_MOVE    = CONST.WALL_MOVEMENT_TYPES?.NONE   ?? 0;
  const NORMAL_SENSE = CONST.WALL_SENSE_TYPES?.NORMAL    ?? 20;
  const NONE_SENSE   = CONST.WALL_SENSE_TYPES?.NONE      ?? 0;

  const target = should
    ? {
        move:  orig?.move  ?? NORMAL_MOVE,
        sight: orig?.sight ?? NORMAL_SENSE,
        light: orig?.light ?? NORMAL_SENSE,
        sound: orig?.sound ?? NORMAL_SENSE,
      }
    : { move: NONE_MOVE, sight: NONE_SENSE, light: NONE_SENSE, sound: NONE_SENSE };

  const update = {};
  if (wallDoc.move  !== target.move)  update.move  = target.move;
  if (wallDoc.sight !== target.sight) update.sight = target.sight;
  if (wallDoc.light !== target.light) update.light = target.light;
  if (wallDoc.sound !== target.sound) update.sound = target.sound;
  if (!Object.keys(update).length) return;

  await wallDoc.update(update, { admLevelsBindSync: true });
}

// preUpdateWall: when a new binding appears — snapshot the current state.
// On unbinding — restore from the snapshot and delete the snapshot flag.
Hooks.on("preUpdateWall", (wallDoc, changes) => {
  const newBindRaw = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAG_TILE_BIND}`);
  if (newBindRaw === undefined) return; // the binding was not touched in this update
  const newBind = newBindRaw ? String(newBindRaw) : "";
  const oldBind = wallDoc.getFlag(MODULE_ID, FLAG_TILE_BIND) || "";

  if (newBind && newBind !== oldBind) {
    // A binding appeared/changed — snapshot the current state (if not already there).
    // Do NOT overwrite if the snapshot is ALREADY passed in this same update (binding restore
    // by the admaps-scene-switch module on a variant change — the original there is already correct).
    const origProvided = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAG_WALL_ORIG}`) !== undefined;
    if (!wallDoc.getFlag(MODULE_ID, FLAG_WALL_ORIG) && !origProvided) {
      foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${FLAG_WALL_ORIG}`, {
        move:  wallDoc.move,
        sight: wallDoc.sight,
        light: wallDoc.light,
        sound: wallDoc.sound,
      });
    }
  } else if (!newBind && oldBind) {
    // Binding removed — restore the original and delete the snapshot.
    const orig = wallDoc.getFlag(MODULE_ID, FLAG_WALL_ORIG);
    if (orig) {
      if (changes.move  === undefined) changes.move  = orig.move  ?? wallDoc.move;
      if (changes.sight === undefined) changes.sight = orig.sight ?? wallDoc.sight;
      if (changes.light === undefined) changes.light = orig.light ?? wallDoc.light;
      if (changes.sound === undefined) changes.sound = orig.sound ?? wallDoc.sound;
      foundry.utils.setProperty(changes, `flags.${MODULE_ID}.-=${FLAG_WALL_ORIG}`, null);
    }
  }
});

// updateWall: when the binding/inversion/door type/door state changes — re-synchronize.
Hooks.on("updateWall", async (wallDoc, changes, options) => {
  if (options?.admLevelsBindSync) return; // self-initiated update — skip
  const bindChanged   = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAG_TILE_BIND}`)   !== undefined;
  const invertChanged = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAG_TILE_INVERT}`) !== undefined;
  const dsChanged     = "ds" in (changes ?? {});
  const doorChanged   = "door" in (changes ?? {});
  if (!bindChanged && !invertChanged && !dsChanged && !doorChanged) return;
  await _applyWallBindState(wallDoc);
});

// renderWallConfig: add the "Tile binding" UI to the wall settings window.
Hooks.on("renderWallConfig", (app, htmlOrEl) => {
  const element = htmlOrEl instanceof HTMLElement
    ? htmlOrEl
    : (htmlOrEl?.[0] instanceof HTMLElement ? htmlOrEl[0] : (htmlOrEl?.element ?? null));
  if (!element || element.querySelector("[data-adm-wall-bind]")) return;

  const doc = app.document;
  const tileBindId = doc.getFlag(MODULE_ID, FLAG_TILE_BIND) ?? "";
  const tileInvert = !!doc.getFlag(MODULE_ID, FLAG_TILE_INVERT);
  const boundTile = tileBindId ? (doc.parent ?? canvas.scene)?.tiles?.get(tileBindId) : null;
  const tileLabel = boundTile
    ? `${tileBindId.slice(0, 8)}… (${Math.round(boundTile.x)},${Math.round(boundTile.y)})`
    : "—";

  const html = `
    <fieldset data-adm-wall-bind>
      <legend>${game.i18n.localize("ADM_LEVELS.wall.bindLegend")}</legend>
      <div class="form-group" style="flex-direction:column;align-items:flex-start;">
        <div class="form-fields" style="display:flex;flex-direction:column;gap:6px;width:100%;">
          <div style="display:flex;align-items:center;gap:6px;">
            <button type="button" data-adm-wall-pick-tile style="flex:0 0 auto;padding:4px 10px;">${game.i18n.localize("ADM_LEVELS.ui.pickTile")}</button>
            <span data-adm-wall-tile-display style="flex:1;opacity:.85;font-size:12px;">${tileLabel}</span>
            <button type="button" data-adm-wall-clear-tile
              style="flex:0 0 auto;padding:4px 8px;${tileBindId ? "" : "visibility:hidden;"}"
              title="${game.i18n.localize("ADM_LEVELS.ui.clearBind")}">×</button>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
            <input type="checkbox" data-adm-wall-tile-invert ${tileInvert ? "checked" : ""}>
            <span style="font-size:12px;">${game.i18n.localize("ADM_LEVELS.wall.invert")}</span>
          </label>
          <p class="hint" style="font-size:11px;opacity:.7;margin:0;">${game.i18n.localize("ADM_LEVELS.wall.hint")}</p>
          <!-- The named inputs live INSIDE the .form-group on purpose: Mass Edit (Ctrl+E on several
               walls) gives a form-group its "apply" checkbox only if the group contains a [name] field,
               ticks it on any click/change inside the group, and on save collects [name] fields only
               from ticked groups. Outside the group these flags were never applied to the selection. -->
          <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TILE_BIND}" value="${tileBindId}">
          <input type="hidden" name="flags.${MODULE_ID}.${FLAG_TILE_INVERT}" value="${tileInvert ? "true" : ""}">
        </div>
      </div>
    </fieldset>
  `;

  // Insert at the end of the form (or after the last fieldset).
  const form = element.querySelector("form") ?? element;
  const footer = form.querySelector("footer") ?? form.querySelector(".form-footer");
  if (footer) footer.insertAdjacentHTML("beforebegin", html);
  else form.insertAdjacentHTML("beforeend", html);

  // Remove duplicate Foundry-auto inputs for these flags.
  for (const f of [FLAG_TILE_BIND, FLAG_TILE_INVERT]) {
    const name = `flags.${MODULE_ID}.${f}`;
    const all = element.querySelectorAll(`[name="${name}"]`);
    const ours = element.querySelector(`fieldset[data-adm-wall-bind] [name="${name}"]`);
    for (const inp of all) if (inp !== ours) inp.remove();
  }

  // --- Controls ---
  const pickBtn   = element.querySelector("[data-adm-wall-pick-tile]");
  const clearBtn  = element.querySelector("[data-adm-wall-clear-tile]");
  const display   = element.querySelector("[data-adm-wall-tile-display]");
  const invertCb  = element.querySelector("[data-adm-wall-tile-invert]");
  const hiddenBind   = element.querySelector(`fieldset[data-adm-wall-bind] [name="flags.${MODULE_ID}.${FLAG_TILE_BIND}"]`);
  const hiddenInvert = element.querySelector(`fieldset[data-adm-wall-bind] [name="flags.${MODULE_ID}.${FLAG_TILE_INVERT}"]`);

  function _setBinding(tileId) {
    if (!hiddenBind) return;
    hiddenBind.value = tileId || "";
    // Mass Edit (Ctrl+E on several walls): our pick/clear buttons stop propagation, so its
    // delegated click handler never ticks the group's "apply" checkbox — tick it here.
    // No-op in the stock single-wall window (no checkbox).
    try {
      const cb = element.querySelector("fieldset[data-adm-wall-bind] .form-group .mass-edit-checkbox input");
      if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    } catch (_e) {}
    if (display) {
      if (tileId) {
        const t = (app.document?.parent ?? canvas.scene)?.tiles?.get(tileId);
        const coords = t ? `(${Math.round(t.x)},${Math.round(t.y)})` : "";
        display.textContent = `${tileId.slice(0, 8)}… ${coords}`;
      } else {
        display.textContent = "—";
      }
    }
    if (clearBtn) clearBtn.style.visibility = tileId ? "visible" : "hidden";
  }

  pickBtn?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ui.notifications?.info?.(game.i18n.localize("ADM_LEVELS.ui.clickTile"));
    pickBtn.disabled = true;
    pickBtn.textContent = game.i18n.localize("ADM_LEVELS.ui.pickTileWait");
    try {
      const tile = await _pickTileOnCanvas();
      if (tile) _setBinding(tile.id);
    } catch (e) { console.warn("[adm-levels] wall pick tile", e); }
    finally {
      pickBtn.disabled = false;
      pickBtn.textContent = game.i18n.localize("ADM_LEVELS.ui.pickTile");
    }
  });

  clearBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    _setBinding("");
  });

  invertCb?.addEventListener("change", () => {
    if (hiddenInvert) hiddenInvert.value = invertCb.checked ? "true" : "";
  });

  // Spoiler: "Tile binding" (our fieldset) + "Tagger" (from a third-party module)
  // take a lot of space in the wall settings window — wrap them in <details> so
  // they are collapsed by default. setTimeout(0) — gives Tagger time to insert
  // its fieldset (the order of renderWallConfig hooks is not guaranteed).
  setTimeout(() => {
    if (element.querySelector("[data-adm-wall-extras-spoiler]")) return;
    const ourFs = element.querySelector("fieldset[data-adm-wall-bind]");
    const tagFs = element.querySelector("fieldset.tagger");
    if (!ourFs && !tagFs) return;

    const details = document.createElement("details");
    details.dataset.admWallExtrasSpoiler = "1";
    details.style.cssText = "margin:6px 0;border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:4px 8px;";
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;user-select:none;opacity:.85;font-size:12px;";
    summary.textContent = game.i18n.localize("ADM_LEVELS.wall.spoiler");
    details.appendChild(summary);

    // Insert the spoiler RIGHT WHERE our fieldset is now (or Tagger's, if ours
    // is absent). Then move both fieldsets inside the spoiler.
    const anchor = ourFs ?? tagFs;
    anchor.parentNode?.insertBefore(details, anchor);
    if (ourFs) details.appendChild(ourFs);
    if (tagFs) details.appendChild(tagFs);
  }, 0);
});

/* ------------------------------------------------------------------ */
/*  Elevation lookup (used by createTerrainMovementPath wrap)          */
/* ------------------------------------------------------------------ */

// Expose for system distance/movement calculations.
globalThis.__admLevelsElevAtXY = function(px, py, tokenElev) { return _elevationAtXY(px, py, tokenElev); };
// Expose water detection for system (swim status + movement swap).
globalThis.__admWaterAtXY = function(px, py, tokenElev) { return _waterAtXY(px, py, tokenElev); };

/** Returns { region, surface, bottom } if the token is in a water region
 *  (checked via tokenDoc.regions — Foundry maintains this collection itself) AND
 *  its elevation <= surface, otherwise null. */
function _waterForToken(tokenDoc) {
  if (!_regionsOn()) return null;
  if (_ignoresRegionEffects(tokenDoc)) return null; // transport — the token does not sink
  const regs = tokenDoc?.regions;
  if (!regs || !regs.size) return null;
  const tokenElev = Number(tokenDoc.elevation ?? 0);
  for (const regionDoc of regs) {
    if (regionDoc.getFlag(MODULE_ID, FLAG_TYPE) !== "water") continue;
    if (_isRegionEffectivelyDisabled(regionDoc)) continue;
    const surface = _keyToFt(regionDoc.getFlag(MODULE_ID, FLAG_ELEVATION));
    const botFlag = regionDoc.getFlag(MODULE_ID, FLAG_FLOOR);
    const bottom = botFlag ? _keyToFt(botFlag) : (surface - 15);
    if (tokenElev <= surface) return { region: regionDoc.object, surface, bottom };
  }
  return null;
}

/** Legacy XY-based check — used in a few places (elev snap, createToken). */
function _waterAtXY(px, py, tokenElev = 0) {
  if (!_regionsOn()) return null;
  if (!canvas.regions?.placeables) return null;
  for (const region of canvas.regions.placeables) {
    const doc = region.document;
    if (doc.getFlag(MODULE_ID, FLAG_TYPE) !== "water") continue;
    if (_isRegionEffectivelyDisabled(doc)) continue;
    if (!doc.testPoint({ x: px, y: py, elevation: tokenElev })) continue;
    const surface = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
    const botFlag = doc.getFlag(MODULE_ID, FLAG_FLOOR);
    const bottom = botFlag ? _keyToFt(botFlag) : (surface - 15);
    if (tokenElev <= surface) return { region, surface, bottom };
  }
  return null;
}

/** Surface of the water region under point XY (WITHOUT regard to token elevation) — for the
 *  snap when entering water (walk). Returns surface (ft) or null if there is no water here. */
function _waterSurfaceAtXY(px, py) {
  if (!_regionsOn()) return null;
  if (!canvas.regions?.placeables) return null;
  for (const region of canvas.regions.placeables) {
    if (!_regionBoxHas(region, px, py)) continue;
    const doc = region.document;
    if (doc.getFlag(MODULE_ID, FLAG_TYPE) !== "water") continue;
    if (_isRegionEffectivelyDisabled(doc)) continue;
    const surface = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
    if (doc.testPoint({ x: px, y: py, elevation: surface })
        || doc.testPoint({ x: px, y: py, elevation: 0 })) return surface;
  }
  return null;
}

/** Is the point within `eps` px of any edge of a flat polygon [x0,y0,x1,y1,…]? Cheap (pure math),
 *  used only on ray-cast misses — see the boundary note in _elevationAtXY. */
function _pointNearPolyEdge(px, py, pts, eps = 0.5) {
  const e2 = eps * eps;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const x1 = pts[j], y1 = pts[j + 1], x2 = pts[i], y2 = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx - px, qy = y1 + t * dy - py;
    if (qx * qx + qy * qy <= e2) return true;
  }
  return false;
}

/** Is the point ON the outline of the region (the union of its shapes, holes included)? */
function _pointOnRegionOutline(doc, px, py, eps = 0.5) {
  let tree = null;
  try { tree = doc.polygonTree; } catch (_e) { return false; }
  if (!tree) return false;
  for (const node of tree) {
    const pts = node.polygon?.points;
    const b = node.bounds;
    if (!pts || pts.length < 6 || !b) continue;
    if (px < b.x - eps || px > b.x + b.width + eps || py < b.y - eps || py > b.y + b.height + eps) continue;
    if (_pointNearPolyEdge(px, py, pts, eps)) return true;
  }
  return false;
}

function _elevationAtXY(px, py, tokenElev = 0) {
  if (!_regionsOn()) return null;   // master switch: the same answer as for a scene without regions
  if (!canvas.regions?.placeables) return null;
  let bestElev = null, bestAbs = 0, bestType = null;

  // ⚠️ doc.testPoint, not region.testPoint: in v13 the placeable's testPoint is deprecated, and every call builds an
  // Error with its stack for the compatibility warning — ~20 µs against ~0.1 µs, on every region for every point. The
  // pathfinder asks this thousands of times per search, the elevation snap on every mouse move (24.09.2026).
  for (const region of canvas.regions.placeables) {
    if (!_regionBoxHas(region, px, py)) continue;
    const doc = region.document;
    const type = doc.getFlag(MODULE_ID, FLAG_TYPE);
    if (!type) continue;
    if (_isRegionEffectivelyDisabled(doc)) continue;
    // Water AND transport regions do not snap elevation (transport is only carrying + immunity;
    // elevation is set by the real floor under the transport: ground/plateau/stairs).
    if (type === "water" || type === "transport") continue;

    // Check elevation bounds: if region has explicit bounds, respect them.
    const bot = doc.elevation?.bottom;
    const top = doc.elevation?.top;
    const hasBounds = Number.isFinite(bot) || Number.isFinite(top);

    let inside = false;
    // A point exactly ON a plateau outline (a cell cut in half right through its centre, e.g. by a
    // corner-to-corner diagonal) does NOT change the level: it belongs to the plateau only for a
    // token that is already at the plateau's level. From the ground such a cell stays ground (no
    // lift, and the drag keeps its distance label); from the plateau it stays plateau. This also
    // keeps the octagonal-column case working: the corner cells' centres lie on the slanted edges,
    // a token leaving the top keeps 15 there and steps off over the 0–15 wall, while from the
    // ground the corner cell is ground and the wall still blocks the climb. Stairs keep the old
    // "edge counts as inside" rule below — a ramp is meant to be walked across its edges.
    if (type === "plateau" && _pointOnRegionOutline(doc, px, py)) {
      const lvl = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
      if (!(Math.abs(lvl - (Number(tokenElev) || 0)) < 0.5)) continue;
      inside = true;
    } else if (hasBounds) {
      // Use testPoint with token's current elevation — respects bounds + holes.
      inside = doc.testPoint({ x: px, y: py, elevation: tokenElev });
    } else {
      // Without bounds, elevation does NOT affect testPoint (bottom/top = ±∞) — ONE
      // answer is enough. There used to be a loop over nine elevations here: on misses
      // (point outside the region) it paid 9× testPoint for EVERY region, and the function
      // is hot — it is called by the elevation snap on every mouse move while dragging
      // (plus the binary edge search), and by visibility checks across all tokens.
      // On "Winter Ball" (a 14-polygon region) this caused freezes on stairs.
      inside = doc.testPoint({ x: px, y: py, elevation: 0 });
      if (!inside) {
        for (const shape of doc.shapes) {
          if (shape.points?.length >= 6) {
            const pts = shape.points; let c = false;
            for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
              const yi = pts[i+1], yj = pts[j+1], xi = pts[i], xj = pts[j];
              if (((yi > py) !== (yj > py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) c = !c;
            }
            // A point ON the edge counts as inside — for stairs only now (plateau outlines are
            // decided above by the token's level). testPoint/ray-cast answer "outside" for such
            // a point on some sides of a polygon, which left a gap in the ramp.
            if (!c && _pointNearPolyEdge(px, py, pts, 0.5)) c = true;
            if (c) { inside = true; break; }
          } else if (shape.width != null) {
            const sx = shape.x ?? 0, sy = shape.y ?? 0;
            if (px >= sx && px <= sx + shape.width && py >= sy && py <= sy + shape.height) { inside = true; break; }
          }
        }
      }
    }
    if (!inside) continue;

    let numElev;
    if (type === "stairs") {
      numElev = _computeRampElevation(region, px, py);
    } else {
      numElev = _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION));
    }

    const absElev = Math.abs(numElev);
    // Stairs override a plateau: if stairs are already chosen — a plateau will not replace them.
    // If stairs come in while the best is a plateau, the stairs win regardless of |elev|.
    if (bestType === "stairs" && type !== "stairs") continue;
    if (type === "stairs" && bestType !== "stairs") {
      bestElev = numElev; bestAbs = absElev; bestType = type;
      continue;
    }
    // Same type — the old "max |elev|" logic.
    if (bestElev === null || absElev > bestAbs) { bestElev = numElev; bestAbs = absElev; bestType = type; }
  }
  return bestElev;
}

function _wasInElevationRegion(e) {
  if (e === 0) return false;
  const cellFt = _cellFt();
  const maxE = Math.max(...HEIGHT_OPTIONS.map(h => Math.abs(h.ft)));
  const abs = Math.abs(e);
  return abs <= maxE && Math.abs(abs % cellFt) < 0.01;
}

/**
 * Insert a point at the EDGE of an elevation region.
 *
 * Why: a drag path consists of two points, and core spreads the elevation between
 * them evenly. A token leaving a roof started descending from the very first step. We find
 * the place where the region under the path changes and put a pair of points there: at the edge —
 * the previous elevation, right after it — the new one (assigned by the snap). The descent ends up
 * vertical and exactly where the roof ends.
 *
 * The edge is found by bisecting the segment — ten steps give sub-pixel
 * precision, and it is cheaper than splitting the whole path by cells.
 */
function _splitAtRegionEdge(waypoints, halfW, halfH, startZ, gs) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) return waypoints;
  const out = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    // ⚠️ A "displace" step (a teleport jump) has no path to cut. The inserted points carry no action, core
    // gives them the previous one — the token's "walk" — and the jump became a walk that walls stop: the
    // region teleport t2 → t1 (30 → 15) got stuck in the mast platform's wall (23.09.2026, Modular_Ship_Pack).
    if (String(b?.action ?? "").toLowerCase() === "displace") { out.push(b); continue; }
    const ax = Number(a.x) || 0, ay = Number(a.y) || 0;
    const bx = Number(b.x ?? ax) || 0, by = Number(b.y ?? ay) || 0;
    try {
      const za = _elevationAtXY(ax + halfW, ay + halfH, startZ);
      const zb = _elevationAtXY(bx + halfW, by + halfH, startZ);
      if (za !== zb) {
        let lo = 0, hi = 1;
        for (let s = 0; s < 10; s++) {
          const mid = (lo + hi) / 2;
          const mz = _elevationAtXY(ax + (bx - ax) * mid + halfW, ay + (by - ay) * mid + halfH, startZ);
          if (mz === za) lo = mid; else hi = mid;
        }
        const at = (t) => ({ x: Math.round(ax + (bx - ax) * t), y: Math.round(ay + (by - ay) * t) });
        // ⚠️ DO NOT ADD A MARGIN PAST THE EDGE. We tried pushing the descent one cell
        // outward — it got worse: the token stayed hanging at roof height already ABOVE
        // THE GROUND, and the first-floor walls end exactly there. It looked over
        // all the partitions from the street, and the whole floor opened up to the player. The descent
        // must happen exactly where the region ends.
        let edge = at(lo);
        const after = at(Math.min(1, hi));
        const endX = Math.round(bx), endY = Math.round(by);
        const len = Math.hypot(bx - ax, by - ay);
        // The edge runs through the destination itself: keep the edge point one pixel short of it.
        // A point on top of the destination makes the last step zero-length, and Foundry then
        // draws no distance label for the drag at all.
        if (edge.x === endX && edge.y === endY && len >= 2) {
          edge = { x: Math.round(bx - (bx - ax) / len), y: Math.round(by - (by - ay) / len) };
        }
        // At the edge — the previous elevation; the next point gets its elevation from the snap.
        out.push({ ...edge, elevation: (za ?? startZ) });
        // "Right after the edge" is only needed when it is not the destination (pushed below anyway).
        if ((after.x !== edge.x || after.y !== edge.y) && (after.x !== endX || after.y !== endY)) out.push(after);
      }
    } catch (_e) { /* could not find the edge — the path stays as it was */ }
    out.push(b);
  }
  return out;
}

/** Does a stairs region lie on (or next to) the segment? Box test — cheap, gates _walkArrival. */
function _rampOnSegment(ax, ay, bx, by, pad) {
  const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
  const minY = Math.min(ay, by) - pad, maxY = Math.max(ay, by) + pad;
  for (const region of canvas.regions?.placeables ?? []) {
    const doc = region.document;
    if (doc.getFlag(MODULE_ID, FLAG_TYPE) !== "stairs" || _isRegionEffectivelyDisabled(doc)) continue;
    const b = _regionBounds(region);
    if (b && (b.minX <= maxX) && (b.maxX >= minX) && (b.minY <= maxY) && (b.maxY >= minY)) return true;
  }
  return false;
}

/**
 * The elevation a WALKER has on reaching B from A (token centres), the terrain carrying it along the way.
 *
 * Why: an upper floor bounded to its own level (plateau 15..15 over a room with floor 0) counts only for a
 * token already at 15, and a walker gets there only up a ramp — stepping on its top step. A move that jumped
 * over that step (a drag from a lower step straight onto the roof) read the roof from the lower step's level
 * and dropped the token into the room below. So where a ramp lies on the segment, the segment is walked in
 * 1/8-cell steps — fine enough to land on a ramp's top step. Elsewhere nothing changes: the level is the
 * previous point's.
 */
function _walkArrival(ax, ay, bx, by, z0, gs) {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1 || !_rampOnSegment(ax, ay, bx, by, gs / 2)) return z0;
  const n = Math.ceil(len / Math.max(2, gs / 8));
  let z = z0;
  for (let k = 1; k < n; k++) {
    const px = ax + (((bx - ax) * k) / n), py = ay + (((by - ay) * k) / n);
    const r = _elevationAtXY(px, py, z);
    if (r !== null) z = r;
    else if ((_waterSurfaceAtXY(px, py) === null) && _wasInElevationRegion(z)) z = 0; // walked off a floor
  }
  return z;
}

/**
 * The drag preview («ghost») at the elevation of the planned path's last point.
 *
 * Why: core puts the ghost at the DRAG DESTINATION's elevation (Token.#updateDragPreview) — the token's own,
 * unless changed by keys — and never looks at the terrain: the terrain elevation lives only in the planned
 * path (createTerrainMovementPath → _plannedMovement). Since the snap carries a walker up the stairs onto a
 * roof (_walkArrival), the ghost of a token dragged from the deck (0) onto the roof (15) stood at 0 and was
 * sorted UNDER the roof tile — the drag showed an empty frame (23.09.2026). Called after the ruler refresh,
 * which follows every update of the planned path (instant or found later).
 */
function _ghostToPlannedElevation(token) {
  const planned = token?._plannedMovement?.[game.user.id];
  const last = planned?.unreachableWaypoints?.at(-1) ?? planned?.foundPath?.at(-1);
  const z = Number(last?.elevation);
  if (!Number.isFinite(z)) return;
  const ghost = token.layer?._draggedToken?.mouseInteractionManager?.interactionData?.contexts?.[token.document.id]?.clonedToken;
  if (!ghost || ghost.destroyed || (ghost.document.elevation === z)) return;
  ghost.document.elevation = z;
  ghost.renderFlags.set({ refreshElevation: true });
}

Hooks.once("ready", () => {
  try {
    if (!globalThis.libWrapper?.register) return;
    libWrapper.register(MODULE_ID, "foundry.canvas.placeables.Token.prototype._refreshRuler", function (wrapped, ...args) {
      const result = wrapped(...args);
      try { if (_regionsOn()) _ghostToPlannedElevation(this); } catch (e) { console.warn("[ADM:LEVELS] ghost elevation", e); }
      return result;
    }, "WRAPPER");
  } catch (e) { console.warn("[ADM:LEVELS] ghost elevation wrapper", e); }
});

/* ------------------------------------------------------------------ */
/*  Wrap createTerrainMovementPath                                     */
/* ------------------------------------------------------------------ */

Hooks.once("ready", () => {
  const Proto = Token.prototype;
  const origFn = Proto.createTerrainMovementPath;
  if (typeof origFn !== "function") {
    console.warn("[ADM:LEVELS] createTerrainMovementPath not found, using fallback.");
    _registerFallback();
    return;
  }

  Proto.createTerrainMovementPath = function (waypoints, options) {
    try {
      // Bypass elevation-magnet for binding/forced moves. Check BOTH the global flag
      // AND the options._admBindingMove option: the flag lives only synchronously (the initiator
      // clears it in finally), while the snap may commit the path in a DEFERRED update — by then the
      // flag is already false, but the option stays on the update itself (teleport/carry set both).
      if (globalThis.__admBindingMoveInProgress || options?._admBindingMove) return origFn.call(this, waypoints, options);
      // Elevation regions master switch: hand over the stock calculation, as if the module were absent.
      if (!_regionsOn()) return origFn.call(this, waypoints, options);

      // ⚠️ The COMMITTED position (_source), not this.document: while a move animates, core writes the interpolated
      // x/y/elevation into the document every frame (Token #animateFrame → mergeObject(this.document, …)). A keyboard
      // step taken during the previous step's animation (quick WASD) then started from a point between two cells at an
      // in-between elevation (27.5 on the stern stairs 15 → 30): no floor bounded to its own level (plateau 30..100,
      // roof 15..15) is seen from there, the token «walked off a floor» to 0 and fell through (24.09.2026). Core itself
      // computes a keyboard step from _source (Token#_getShiftedPosition).
      const _src = this.document?._source ?? this.document;
      // Skip if no real XY movement (e.g., elevation-only change via HUD).
      const srcX = _src?.x ?? 0;
      const srcY = _src?.y ?? 0;
      const noMove = waypoints.every(wp =>
        Math.abs((wp.x ?? 0) - srcX) < 1 && Math.abs((wp.y ?? 0) - srcY) < 1
      );
      if (noMove) return origFn.call(this, waypoints, options);

      if (canvas.regions?.placeables?.length) {
        const gs = Number(canvas.grid?.size) || 100;
        const halfW = (Number(this.document?.width ?? 1) || 1) * gs / 2;
        const halfH = (Number(this.document?.height ?? 1) || 1) * gs / 2;
        // "Transport" (boat/wagon) FLOATS on the water surface: it snaps to it like a regular
        // token (immunity to water elevation is removed here). Immunity differs only in swim status and auras.

        // ⚠️ A waypoint's `action` is OPTIONAL (see TokenFindMovementPathWaypoint
        // in core: "Default: the previous or prepared movement action"). Core
        // fills it in LATER, and the point often arrives here without it. Previously
        // "walk" was assumed in that case — and a climbing token at elevation 15 being
        // dragged over water snapped to its surface: the code treated it as a walker.
        // Do as core does: the previous point's action, otherwise the token's own action.
        // ⚠️ POINT AT THE REGION EDGE. A drag has only two points — start and
        // end — and core INTERPOLATES elevation between them. So a token
        // leaving a roof for the ground started descending immediately and rode half the way
        // through the second floor, revealing the first-floor walls to the player along the way. We put
        // one point at the region boundary with the PREVIOUS elevation and a second right after it —
        // its elevation is assigned by the snap below. The descent becomes vertical and exactly
        // where the roof ends. We split only when the start and end elevations
        // differ: ordinary moves across a floor are left alone.
        const _startZ = Number(this.document?._source?.elevation ?? this.document?.elevation ?? 0) || 0;
        const _lastWp = waypoints[waypoints.length - 1];
        const _endZ = Number(_lastWp?.elevation ?? _startZ) || 0;
        if (_startZ !== _endZ) waypoints = _splitAtRegionEdge(waypoints, halfW, halfH, _startZ, gs);

        let _prevAction = String(this.document?.movementAction ?? "walk").toLowerCase();
        // ⚠️ A point's `elevation` is OPTIONAL too — "Default: the previous or
        // source elevation". Previously an empty one was read as "elevation zero", and the token's
        // elevation in the calculation was replaced by ground: the region under the point was looked up
        // at the wrong level, and the water snap compared against zero instead of the real 15 feet.
        let _prevElev = Number(_src?.elevation ?? 0) || 0;
        let _prevX = Number(_src?.x ?? 0) || 0, _prevY = Number(_src?.y ?? 0) || 0;

        for (let i = 0; i < waypoints.length; i++) {
          const wp = waypoints[i];
          const action = String(wp.action ?? _prevAction).toLowerCase();
          _prevAction = action;
          const airborne = (action === "fly" || action === "climb" || action === "swim");

          // ⚠️ A WALKER arrives at this point at the elevation it had on the way here — the terrain carried it
          // (_walkArrival: the previous point's level, walked through a ramp if one lies on the segment) — and
          // the region under the point is looked up from THAT level. The point's own `elevation` is only a
          // plan: the pathfinder (system scripts/pathfinding.mjs) sets every point to the token's CURRENT
          // elevation. On a layered floor (plateau 15 bounded 15..15 over a room with floor 0) the roof was
          // then looked up from the start level: up the stairs 5/10/15, and the first roof cell read as the
          // room below — the token dropped inside, through the wall it had just stepped over from the top
          // stair (23.09.2026, Modular_Ship_Pack forecastle). Airborne tokens keep the plan.
          const wx = Number(wp.x ?? _prevX) || 0, wy = Number(wp.y ?? _prevY) || 0;
          const arriveElev = airborne ? _prevElev
            : _walkArrival(_prevX + halfW, _prevY + halfH, wx + halfW, wy + halfH, _prevElev, gs);
          _prevX = wx; _prevY = wy;
          const curElev = Number(wp.elevation ?? _prevElev) || 0;
          _prevElev = curElev;

          if (action === "burrow") continue;
          // "displace" is an instant placement (teleport): terrain is not applied
          // to it at all. It is what ends a drag, and previously it was
          // treated as walking — so the whole airborne path stopped being
          // airborne and went into the stock calculation, which reset the elevation.
          if (action === "displace") continue;

          const regionElev = _elevationAtXY((wp.x ?? 0) + halfW, (wp.y ?? 0) + halfH, airborne ? curElev : arriveElev);

          if (action === "fly" || action === "climb" || action === "swim") {
            // Fly / Climb / Swim: the player controls the elevation himself.
            const tokenElev = _src?.elevation ?? 0;
            if (action === "swim") {
              // Swim — dive under the water surface freely.
              const waterHere = _waterAtXY((wp.x ?? 0) + halfW, (wp.y ?? 0) + halfH, tokenElev);
              if (!waterHere) {
                // Left the water: pull up to landElev (plateau/ground), like walk,
                // otherwise the token stays underground at the depth where it was swimming.
                const landElev = regionElev ?? 0;
                if (curElev !== landElev) {
                  waypoints[i] = Object.assign({}, wp, { elevation: landElev });
                  _prevElev = landElev;
                }
                continue;
              }
              // Still in water — free dive (snap only to a region ABOVE, if any).
              const airElev = (regionElev !== null && regionElev > tokenElev) ? regionElev : tokenElev;
              if (curElev !== airElev) {
                waypoints[i] = Object.assign({}, wp, { elevation: airElev });
                _prevElev = airElev;
              }
              continue;
            }
            // Fly / Climb: cannot end up BELOW the surface under the point (cannot fly underground).
            // "Floor" = the water surface (if over water — you may descend to it, further = swim)
            // OR land (region/ground 0). Above the floor — elevation is kept (hovering in the air).
            const _wSurf = _waterSurfaceAtXY((wp.x ?? 0) + halfW, (wp.y ?? 0) + halfH);
            const floor = (_wSurf !== null) ? _wSurf : (regionElev !== null ? regionElev : 0);
            const airElev = Math.max(tokenElev, floor);
            if (globalThis.__ADM_LEVELS_MOVE_DEBUG) {
              console.info("[ADM:Levels] point", i, "action:", action,
                "| token elevation:", tokenElev, "| floor:", floor,
                "| water:", _wSurf, "| region:", regionElev,
                "| was:", wp.elevation, "→ now:", airElev);
            }
            if (curElev !== airElev) {
              waypoints[i] = Object.assign({}, wp, { elevation: airElev });
              _prevElev = airElev;
            }
          } else {
            if (globalThis.__ADM_LEVELS_MOVE_DEBUG) {
              console.info("[ADM:Levels] point", i, "action:", action, "(walk branch)",
                "| raw point elevation:", wp.elevation, "| accepted:", curElev,
                "| region:", regionElev,
                "| water:", _waterSurfaceAtXY((wp.x ?? 0) + halfW, (wp.y ?? 0) + halfH));
            }
            if (regionElev !== null && regionElev !== curElev) {
              waypoints[i] = Object.assign({}, wp, { elevation: regionElev });
              _prevElev = regionElev;
            } else if (regionElev === null) {
              // No land under the point. Water: if the point is ABOVE the surface — lower it to the surface
              // (the snap for walking into a sunken body of water; at/below the surface leave it — swimming).
              const surf = _waterSurfaceAtXY((wp.x ?? 0) + halfW, (wp.y ?? 0) + halfH);
              if (surf !== null) {
                if (curElev > surf) {
                  waypoints[i] = Object.assign({}, wp, { elevation: surf });
                  _prevElev = surf;
                }
              } else if (_wasInElevationRegion(curElev)) {
                waypoints[i] = Object.assign({}, wp, { elevation: 0 });
                _prevElev = 0;
              }
            }
          }
        }
      }
      // Shadow check for last waypoint (skip during drag — waypoints are preview, not actual).
      const isDragging = this.mouseInteractionManager?.state >= 3;
      const lastWp = waypoints[waypoints.length - 1];
      if (lastWp && this.document && !isDragging && !this.isPreview && !this._original) {
        const gs2 = Number(canvas.grid?.size) || 100;
        const hw = (Number(this.document?.width ?? 1) || 1) * gs2 / 2;
        const hh = (Number(this.document?.height ?? 1) || 1) * gs2 / 2;
        const finalElev = lastWp.elevation ?? this.document.elevation ?? 0;
        const finalX = (lastWp.x ?? 0) + hw;
        const finalY = (lastWp.y ?? 0) + hh;
        const surface = _elevationAtXY(finalX, finalY, finalElev) ?? 0;
        setTimeout(() => _updateFlightShadowDirect(this, finalElev, surface), 200);
      }
    } catch (e) { console.warn("[ADM:LEVELS]", e); }

    // For fly/climb/swim: skip origFn — it resets elevation causing wrong distance.
    // Our code already handled elevation above.
    // Same case as above: an empty `action` is NOT "walk" but "as the
    // token's". Otherwise an airborne path without an explicit action went into origFn, which
    // resets the elevation.
    const _ownAction = String(this.document?.movementAction ?? "walk").toLowerCase();
    let _sawAir = false;
    const allAir = waypoints.length > 0 && waypoints.every(wp => {
      const a = String(wp.action ?? _ownAction).toLowerCase();
      if (a === "fly" || a === "climb" || a === "swim") { _sawAir = true; return true; }
      // The instant "displace" point does not break an airborne path: it ends
      // a drag, and because of it a climbing token over water went into the stock
      // calculation, which resets the elevation — the very "fell onto the water surface".
      return a === "displace";
    }) && _sawAir;
    if (globalThis.__ADM_LEVELS_MOVE_DEBUG) {
      console.info("[ADM:Levels] path SUMMARY | airborne:", allAir,
        "| points:", waypoints.map(w => `${w.action ?? "—"}@${w.elevation ?? "empty"}`).join(", "),
        "| token elevation:", this.document?.elevation,
        "| token action:", this.document?.movementAction);
    }
    if (allAir) return waypoints;

    const _res = origFn.call(this, waypoints, options);
    if (globalThis.__ADM_LEVELS_MOVE_DEBUG) {
      try {
        console.info("[ADM:Levels] after the core computation:",
          (_res ?? []).map(w => `${w.action ?? "—"}@${w.elevation ?? "empty"}`).join(", "));
      } catch (_e) {}
    }
    return _res;
  };

});

/** The level picked in the Levels layer tool as { bottom, top }, or null when no level is picked. */
function _levelsLayerRange() {
  const ui = globalThis.CONFIG?.Levels?.UI;
  if (!ui?.rangeEnabled) return null;
  const bottom = parseFloat(ui.range?.[0]), top = parseFloat(ui.range?.[1]);
  return (Number.isFinite(bottom) && Number.isFinite(top)) ? { bottom, top } : null;
}

/**
 * Where a token dropped with a Levels level [bottom, top) picked lands at a point: the highest floor inside the
 * level; if none — one standing exactly on the level's top; if none — the highest floor below the level (nothing of
 * this level here, it falls); if every floor is above (a level under the ground) — the lowest one. Candidates are the
 * floors of the regions under the point (plateau levels, ramp heights), each confirmed by _elevationAtXY from its own
 * height — the same answer the elevation snap gives a token standing there — plus the ground: what a token at 0
 * stands on (a region seen from there — a column, a pit, a ramp), otherwise 0.
 * Why: with a level picked in the Levels layer tool, Levels puts every new token at the level's bottom, and the snap
 * on creation looked from the ground (0), where floors bounded to their own level (plateau 30..100) are not seen. On
 * the ship the stern's top deck is the region 30 drawn in the level 15–30 tile: a token dropped there with level 1
 * picked stayed at 15, inside the stern. With nothing of the level at the point (open deck, bare ground) it stayed
 * hanging at the level's bottom (24.09.2026).
 * ⚠️ The ground is a candidate on purpose: bare ground and floors left implicit (a room at 0 under a roof region
 * 15..15, a deck over a cellar −15..−1) are not regions. Without it, level 0 picked put a token dropped in such a room
 * up onto its roof (the "on the top" rule), and a fall from a higher level went through the implicit floor into the cellar.
 */
function _floorInLevel(px, py, bottom, top) {
  const candidates = new Set();
  for (const region of canvas.regions?.placeables ?? []) {
    if (!_regionBoxHas(region, px, py)) continue;
    const doc = region.document;
    const type = doc.getFlag(MODULE_ID, FLAG_TYPE);
    if ((type !== "plateau" && type !== "stairs") || _isRegionEffectivelyDisabled(doc)) continue;
    let inside = false;
    try { inside = !!doc.polygonTree?.testPoint({ x: px, y: py }); } catch { inside = false; }
    if (!inside) continue;
    candidates.add(type === "stairs" ? _computeRampElevation(region, px, py) : _keyToFt(doc.getFlag(MODULE_ID, FLAG_ELEVATION)));
  }
  const floors = [...candidates].filter((z) => Number.isFinite(z) && (_elevationAtXY(px, py, z) === z));
  floors.push(_elevationAtXY(px, py, 0) ?? 0);
  const inside = floors.filter((z) => (z >= bottom) && (z < top));
  if (inside.length) return Math.max(...inside);
  const onTop = floors.find((z) => Math.abs(z - top) < 0.5);
  if (onTop !== undefined) return onTop;
  const below = floors.filter((z) => z < bottom);
  return below.length ? Math.max(...below) : Math.min(...floors);
}

// Token created on canvas: set elevation based on region.
Hooks.on("createToken", (tokenDoc, options, userId) => {
  if (!game.user?.isGM) return;
  const gs = Number(canvas.grid?.size) || 100;
  const cx = tokenDoc.x + (tokenDoc.width * gs) / 2;
  const cy = tokenDoc.y + (tokenDoc.height * gs) / 2;
  // Floor as seen from the ground; 0 or nothing — the token stays as created.
  const fromGround = () => { const g = _elevationAtXY(cx, cy, 0); return (g !== null && g !== 0) ? g : null; };
  let elev;
  let leftLevel = false;
  // A level is picked in the Levels layer tool and Levels put the token at its bottom — the floor of that level at
  // the point; nothing of that level here (level 1 picked over the open deck or bare ground) — it falls to the floor
  // below, the ground (0) included. It used to stay hanging at the level's bottom (24.09.2026).
  const layer = (userId === game.user.id) && !options?.teleport ? _levelsLayerRange() : null;
  const cur = Number(tokenDoc.elevation ?? 0) || 0;
  if (layer && _regionsOn() && (Math.abs(cur - layer.bottom) < 0.01)) {
    const floor = _floorInLevel(cx, cy, layer.bottom, layer.top);
    elev = (Math.abs(floor - cur) < 0.01) ? null : floor;
    leftLevel = (floor < layer.bottom) || (floor >= layer.top);
  } else {
    elev = fromGround();
  }
  if (elev !== null) {
    // teleport+animation:false — Foundry does not treat this as movement,
    // combat activation and movementHistory are not triggered.
    const done = tokenDoc.update({ elevation: elev }, { animation: false, teleport: true });
    // The floor is outside the picked level — on its top (the stern's deck 30 with level 15–30 picked) or below it
    // (the deck 0) — and Levels would hide the token: the floor panel follows it (tools/levels-follow-token.mjs).
    if (leftLevel) Promise.resolve(done).then(() => Hooks.callAll("admTokenPlacedOnFloor", tokenDoc), () => {});
  }
  // Water detection + cleanup of stale statuses (when a token is moved from another scene
  // where it climbed/swam, on the new scene it gets walk — the stale statuses must be removed).
  setTimeout(async () => {
    await _syncWaterStateForToken(tokenDoc);
    const ncx = (tokenDoc.x ?? 0) + ((tokenDoc.width ?? 1) * gs) / 2;
    const ncy = (tokenDoc.y ?? 0) + ((tokenDoc.height ?? 1) * gs) / 2;
    const nElev = Number(tokenDoc.elevation ?? 0);
    const waterInfo = _waterAtXY(ncx, ncy, nElev);
    const curAct = String(tokenDoc.movementAction ?? "walk");
    // If the token is not in water — remove the stale Swimming status.
    if (!waterInfo) {
      try { await globalThis.__admRemoveSwimStatus?.(tokenDoc); } catch (_) {}
    }
    // If movementAction != climb — remove the stale Climbing status.
    if (curAct !== "climb") {
      try { await globalThis.__admRemoveClimbStatus?.(tokenDoc); } catch (_) {}
    }
  }, 150);
});

/* ------------------------------------------------------------------ */
/*  Water detection: swim movement (the status is handled by the system) */
/* ------------------------------------------------------------------ */

/** Water state synchronization — the GM does tokenDoc.update(movementAction + flags).
 *  The system hook on movementAction (footer-bar) then applies/removes the system's Swimming status.
 *  Called from updateToken (passing the new coordinates from changed) and from createToken.
 *
 *  IMPORTANT: pass `destCenter` with the new coordinates from the updateToken hook's `changed` object,
 *  since `tokenDoc.x/y` in v13 may still be old when the hook fires
 *  (animated movement). */
// Module-level recursion guard for the water sync. Previously the option
// `admLevelsWaterSync: true` in tokenDoc.update() was used, but Foundry v13 for some reason blocks
// persisting movementAction when unknown options are passed — verified: a direct update without
// options writes swim, with the option it does not. Replaced with a Set<tokenId>.
const __admWaterSyncing = new Set();

async function _syncWaterStateForToken(tokenDoc, destCenter = null) {
  if (!tokenDoc) return;
  const gs = Number(canvas.grid?.size) || 100;
  let cx, cy, elev;
  if (destCenter) {
    cx = destCenter.x;
    cy = destCenter.y;
    elev = Number(destCenter.elevation ?? 0);
  } else {
    cx = (tokenDoc.x ?? 0) + ((tokenDoc.width ?? 1) * gs) / 2;
    cy = (tokenDoc.y ?? 0) + ((tokenDoc.height ?? 1) * gs) / 2;
    elev = Number(tokenDoc.elevation ?? 0);
  }
  // Transport-immune: NOT in water, elevation is NOT touched (it is on the transport). If stuck in swim/the
  // water flag — quietly return walk + remove the Swimming status (otherwise the marker "swims", and the normal exit branch
  // also pulled elevation to landElev=0). Early return — bypassing all the water logic.
  if (_ignoresRegionEffects(tokenDoc)) {
    const _act = String(tokenDoc.movementAction ?? "walk");
    const _wasIn = !!tokenDoc.getFlag(MODULE_ID, TFLAG_IN_WATER);
    if (_act === "swim" || _wasIn) {
      __admWaterSyncing.add(tokenDoc.id);
      try {
        if (_act === "swim") await tokenDoc.update({ movementAction: "walk" });
        if (_wasIn) await tokenDoc.update({ [`flags.${MODULE_ID}.${TFLAG_IN_WATER}`]: false, [`flags.${MODULE_ID}.-=${TFLAG_PREV_MOV}`]: null });
      } finally { __admWaterSyncing.delete(tokenDoc.id); }
      try { await globalThis.__admRemoveSwimStatus?.(tokenDoc); } catch (_) {}
    }
    return;
  }
  let waterInfo = _waterAtXY(cx, cy, elev);
  const wasInWater = !!tokenDoc.getFlag(MODULE_ID, TFLAG_IN_WATER);
  const currentAction = String(tokenDoc.movementAction ?? "walk");

  // Hovering over water: fly/climb at surface level (or higher) counts as ABOVE the water,
  // without the swim status. Submersion (elev strictly below surface) — already in the water.
  if (waterInfo && (currentAction === "fly" || currentAction === "climb")
      && elev >= waterInfo.surface) {
    waterInfo = null;
  }

  if (waterInfo && !wasInWater) {
    __admWaterSyncing.add(tokenDoc.id);
    try {
      // Separate updates — a combined update with movementAction+flags does not save movementAction.
      // The Swimming status is applied by the SYSTEM hook on the change to movementAction=swim
      // (footer-bar.mjs:6441). The direct call was removed to avoid duplicates.
      if (currentAction === "walk" || currentAction === "fly" || currentAction === "climb") {
        await tokenDoc.update({ movementAction: "swim" });
      }
      await tokenDoc.update({
        [`flags.${MODULE_ID}.${TFLAG_IN_WATER}`]: true,
        [`flags.${MODULE_ID}.${TFLAG_PREV_MOV}`]: currentAction === "swim" ? "walk" : currentAction,
      });
    } finally { __admWaterSyncing.delete(tokenDoc.id); }
  } else if (!waterInfo && wasInWater) {
    const prevAction = String(tokenDoc.getFlag(MODULE_ID, TFLAG_PREV_MOV) ?? "walk");
    __admWaterSyncing.add(tokenDoc.id);
    try {
      const landElev = _elevationAtXY(cx, cy, elev) ?? 0;
      if (currentAction === "swim") {
        if (elev > landElev) {
          // Rising above land (e.g. swam out of the water and is going up) →
          // switch to climb (or fly if prev was fly), keep the elevation.
          const targetAction = prevAction === "fly" ? "fly" : "climb";
          await tokenDoc.update({ movementAction: targetAction });
        } else {
          // Horizontal exit onto land (or below, which is odd) → walk, pull up to landElev.
          const targetAction = prevAction === "swim" ? "walk" : prevAction;
          const moveUpdate = { movementAction: targetAction };
          if (elev !== landElev) moveUpdate.elevation = landElev;
          await tokenDoc.update(moveUpdate);
        }
      } else if (elev < landElev) {
        // Leaving the water in a NON-swim mode (fly/climb/walk): if elev is below
        // the surface — pull up to landElev so as not to get stuck underground.
        // Example: the player dove to -15, switched on fly, moved onto land
        // (landElev=0) — elevation must become 0, not stay at -15.
        await tokenDoc.update({ elevation: landElev });
      }
      await tokenDoc.update({
        [`flags.${MODULE_ID}.${TFLAG_IN_WATER}`]: false,
        [`flags.${MODULE_ID}.-=${TFLAG_PREV_MOV}`]: null,
      });
    } finally { __admWaterSyncing.delete(tokenDoc.id); }
    // The Swimming status is removed by the system hook on the movementAction change (no longer swim).
    // If movementAction did not change (edge case: climb with elev > surface before exit),
    // the direct call removes it:
    if (currentAction !== "swim") {
      try { await globalThis.__admRemoveSwimStatus?.(tokenDoc); } catch (_) {}
    }
  }
}

// Single hook: after any position or movementAction update the GM recomputes the water state.
// We use `changed.x/y/elevation` — the new values, since tokenDoc.x/y in v13
// may lag because of the animated movement system.
// movementAction also triggers the sync — since an action change (fly→walk over water) changes
// the interpretation of the same elev (hovering → submersion).
Hooks.on("updateToken", (tokenDoc, changed, options, userId) => {
  if (!game.user?.isGM) return;
  // Skip recursion from our own secondary update (via the module-level Set).
  if (__admWaterSyncing.has(tokenDoc.id)) return;
  // IMPORTANT: do NOT skip binding moves (__admBindingMoveInProgress / options._admBindingMove).
  // Without this a bound token dragged into water by its owner does not get movementAction=swim
  // and does not "sink". Water-sync changes only movementAction+flags, not coordinates, so
  // it does not conflict with the binding logic (binding-preUpdate looks only at x/y/elevation).
  const posChanged = "x" in changed || "y" in changed || "elevation" in changed;
  const movChanged = "movementAction" in changed;
  if (!posChanged && !movChanged) return;

  const gs = Number(canvas.grid?.size) || 100;
  const newX = changed.x ?? tokenDoc.x ?? 0;
  const newY = changed.y ?? tokenDoc.y ?? 0;
  const newElev = Number(changed.elevation ?? tokenDoc.elevation ?? 0);
  const cx = newX + ((tokenDoc.width ?? 1) * gs) / 2;
  const cy = newY + ((tokenDoc.height ?? 1) * gs) / 2;

  _syncWaterStateForToken(tokenDoc, { x: cx, y: cy, elevation: newElev })
    .catch(e => console.warn("[ADM:LEVELS] water sync", e));
});

// Transport (boat/wagon) is NOT slowed by the "swimming" animation speed on water:
// an immune transport token moves at FULL speed (Foundry/water applied defaultSpeed/2 = twice as slow).
Hooks.on("preUpdateToken", (doc, change, options) => {
  if (change.x == null && change.y == null) return;   // not a move
  if (options?.teleport) return;
  if (!_ignoresRegionEffects(doc)) return;             // only transport-immune ones (boat + passengers)
  options.animation = options.animation ?? {};
  options.animation.movementSpeed = (CONFIG?.Token?.movement?.defaultSpeed ?? 6); // full speed
});

// When the region type changes, the tokens' water state must be recomputed.
Hooks.on("updateRegion", (regionDoc, changed) => {
  if (!_regionsOn()) return;
  if (!game.user?.isGM) return;
  const typeChanged = foundry.utils.getProperty(changed, `flags.${MODULE_ID}.${FLAG_TYPE}`) !== undefined;
  const elevChanged = foundry.utils.getProperty(changed, `flags.${MODULE_ID}.${FLAG_ELEVATION}`) !== undefined;
  if (!typeChanged && !elevChanged) return;
  // Recompute the state of all tokens on the scene — a simple re-check.
  for (const td of (canvas.scene?.tokens ?? [])) {
    _syncWaterStateForToken(td).catch(() => {});
  }
});

// On page load (F5) restore the water state for tokens in water regions.
// Foundry does not persist movementAction — on reload it is "walk". So
// here we reconstruct it directly from the token's actual position.
Hooks.on("canvasReady", async () => {
  if (!game.user?.isGM) return;
  await new Promise(r => setTimeout(r, 1000));
  const gs = Number(canvas.grid?.size) || 100;
  for (const td of (canvas.scene?.tokens ?? [])) {
    try {
      const cx = (td.x ?? 0) + ((td.width ?? 1) * gs) / 2;
      const cy = (td.y ?? 0) + ((td.height ?? 1) * gs) / 2;
      const elev = Number(td.elevation ?? 0);
      // Transport-immune ones (boat/passengers float on the surface) are NOT in water → no swim/Swimming status.
      // Previously this resync did not check immunity → after F5 all transport "sank" (got swim).
      const waterInfo = _ignoresRegionEffects(td) ? null : _waterAtXY(cx, cy, elev);
      const currentAction = String(td.movementAction ?? "walk");
      const inFlag = !!td.getFlag?.(MODULE_ID, TFLAG_IN_WATER);

      // Hovering guard: fly/climb at/above surface — not in water, leave it alone.
      const hoveringAbove = waterInfo
        && (currentAction === "fly" || currentAction === "climb")
        && elev >= waterInfo.surface;

      if (waterInfo && !hoveringAbove) {
        __admWaterSyncing.add(td.id);
        try {
          await td.update({ movementAction: "swim" });
          const flagUpdates = {
            [`flags.${MODULE_ID}.${TFLAG_IN_WATER}`]: true,
          };
          if (currentAction !== "swim") {
            flagUpdates[`flags.${MODULE_ID}.${TFLAG_PREV_MOV}`] = currentAction;
          }
          await td.update(flagUpdates);
        } finally { __admWaterSyncing.delete(td.id); }
        await globalThis.__admApplySwimStatus?.(td);
      } else {
        // Not in water: clean up the stale state (flags + movementAction itself, if stuck in swim).
        const _prevMov = String(td.getFlag?.(MODULE_ID, TFLAG_PREV_MOV) ?? "walk");
        if (inFlag || currentAction === "swim") {
          __admWaterSyncing.add(td.id);
          try {
            const _u = {
              [`flags.${MODULE_ID}.${TFLAG_IN_WATER}`]: false,
              [`flags.${MODULE_ID}.-=${TFLAG_PREV_MOV}`]: null,
            };
            // Stuck in swim but NOT in water (e.g. standing on transport) → return walk, otherwise the marker "swims".
            if (currentAction === "swim") _u.movementAction = (_prevMov === "swim" ? "walk" : _prevMov);
            await td.update(_u);
          } finally { __admWaterSyncing.delete(td.id); }
        }
        // Remove the Swimming status if it remains (the token is physically not in water).
        await globalThis.__admRemoveSwimStatus?.(td);
        // Remove the Climbing status if it remains but movementAction is not climb.
        if (currentAction !== "climb") {
          await globalThis.__admRemoveClimbStatus?.(td);
        }
      }
    } catch (e) { console.warn("[ADM:LEVELS] canvasReady cleanup", e); }
  }
});

// Shadow: DISABLED — was causing TokenMagic/JB2A conflicts.
// TODO: re-enable with PIXI-based shadow that doesn't touch TokenMagic.
/*
const _shadowGfx = new Map();
Hooks.on("refreshToken", (token) => {
  if (token.isPreview || token._original) return;
  _updatePixiShadow(token);
});
Hooks.on("canvasReady", () => {
  _shadowGfx.clear();
  setTimeout(() => {
    for (const token of (canvas.tokens?.placeables || [])) _updatePixiShadow(token);
  }, 500);
});
Hooks.on("deleteToken", (td) => {
  const g = _shadowGfx.get(td.id);
  if (g) { try { g.destroy(); } catch (_e) {} _shadowGfx.delete(td.id); }
});
*/

function _registerFallback() {
  Hooks.on("updateToken", (tokenDoc, changed, options) => {
    if (!Object.hasOwn(changed, "x") && !Object.hasOwn(changed, "y")) return;
    if (!game.user.isGM) return;
    // Skip elevation override for binding moves (flag OR option — the option survives
    // a deferred commit, when the initiator has already cleared the global flag).
    if (globalThis.__admBindingMoveInProgress || options?._admBindingMove) return;
    // Skip for fly/climb/swim — the player controls elevation himself (the snap does not fire).
    const action = String(tokenDoc.movementAction ?? "walk").toLowerCase();
    if (action === "fly" || action === "climb" || action === "swim") return;
    const token = tokenDoc.object;
    if (!token) return;
    const center = token.getCenterPoint(token.document._source);
    const curE = tokenDoc.elevation ?? 0;
    const elev = _elevationAtXY(center.x, center.y, curE);
    if (elev !== null) { if (curE !== elev) tokenDoc.update({ elevation: elev }); }
    else if (_wasInElevationRegion(curE)) tokenDoc.update({ elevation: 0 });
  });
}

// Fix for Sequencer attach-to-token effects:
// when a token descends, Sequencer does not roll back the effect's elevation → the effect is drawn on top.
// Solution: on every refreshToken synchronize the elevation of attached
// PersistentCanvasEffect with the token's current elevation.
Hooks.on("refreshToken", (token) => {
  try {
    const tokenDoc = token?.document;
    if (!tokenDoc) return;
    const newElev = Number(tokenDoc.elevation ?? 0) || 0;
    const tokenUuid = tokenDoc.uuid;
    const children = canvas?.primary?.children ?? [];
    let changedAny = false;
    for (const c of children) {
      if (!c || c.constructor?.name !== "PersistentCanvasEffect") continue;
      const matchesObj = c.source === token;
      const matchesUuid = String(c?.data?.source ?? "") === tokenUuid;
      if (!matchesObj && !matchesUuid) continue;
      if (c.elevation !== newElev) {
        c.elevation = newElev;
        changedAny = true;
      }
    }
    if (changedAny) {
      canvas.primary.sortDirty = true;
      try { canvas.primary.sortChildren(); } catch (_) {}
    }
  } catch (_e) {}
});

/* -------------------------------------------- */
/* Flight Shadow (PIXI ellipse)                  */
/* -------------------------------------------- */

/**
 * Direct shadow check with pre-computed elevation/surface (called from createTerrainMovementPath).
 */
/*
function _updatePixiShadow(token) {
  if (!token?.document) return;
  const doc = token.document;
  const curE = doc.elevation ?? 0;
  const gs = Number(canvas.grid?.size) || 100;
  const cx = doc.x + (doc.width * gs) / 2;
  const cy = doc.y + (doc.height * gs) / 2;
  const surfaceRaw = _elevationAtXY(cx, cy, curE);
  const surfaceElev = surfaceRaw ?? 0;
  const isAbove = curE > surfaceElev && curE !== 0;

  let g = _shadowGfx.get(token.id);

  if (!isAbove) {
    if (g) { g.visible = false; }
    return;
  }

  // Draw or update shadow ellipse
  const w = (doc.width ?? 1) * gs;
  const h = (doc.height ?? 1) * gs;

  if (!g || g.destroyed) {
    g = new PIXI.Graphics();
    g.eventMode = "none";
    _shadowGfx.set(token.id, g);
  }

  g.clear();
  g.beginFill(0x000000, 0.35);
  g.drawEllipse(0, 0, w * 0.4, h * 0.2);
  g.endFill();

  // Position under token (slightly below center)
  g.x = token.x + w / 2;
  g.y = token.y + h * 0.85;
  g.zIndex = token.zIndex - 1;
  g.visible = true;

  // Add to canvas.tokens if not already there
  if (g.parent !== canvas.tokens) {
    try { canvas.tokens.addChild(g); } catch (_e) {}
  }
}

*/
// Compat stubs for createTerrainMovementPath calls
function _updateFlightShadowDirect() {}
function _updateFlightShadow() {}

/* ============================================================
 *  Teleport-lines overlay (GM): while Alt is HELD, draw lines from
 *  teleport regions to their destinations — to see at once where
 *  each teleport leads. Same scene → line+arrow; another scene →
 *  a stub arrow + label "→ Scene: Region". World coordinates (pans
 *  together with the canvas). Removed on keyup/blur/scene change.
 * ============================================================ */
const TP_TextClass = foundry?.canvas?.containers?.PreciseText ?? PIXI.Text;
const TP_PALETTE = [0x3de8ff, 0xffd23d, 0xff5ec4, 0x7dff5e, 0xff8a3d, 0xa77dff, 0x5eafff, 0xff6b6b];
let _tpContainer = null;
let _tpAltActive = false;

function _tpColorFor(id) {
  let h = 0; const s = String(id || "");
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) >>> 0);
  return TP_PALETTE[h % TP_PALETTE.length];
}

// Region center from document.bounds (available without rendering the placeable). null if empty.
function _tpRegionCenter(regionDoc) {
  try {
    const b = regionDoc?.bounds;
    if (b && b.width > 0 && b.height > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const c = regionDoc?.object?.center;
    return c ? { x: c.x, y: c.y } : null;
  } catch (_e) { return null; }
}

// Line from→to with an arrowhead at to and a dot at from. Offset to the right of the direction —
// so opposing (bidirectional) teleports do not merge into one line.
function _tpDrawArrow(g, from, to, color) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const ox = Math.cos(ang + Math.PI / 2) * 8;
  const oy = Math.sin(ang + Math.PI / 2) * 8;
  const fx = from.x + ox, fy = from.y + oy, tx = to.x + ox, ty = to.y + oy;
  g.lineStyle({ width: 3, color, alpha: 0.9, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(fx, fy); g.lineTo(tx, ty);
  const ah = 20, spread = Math.PI / 7;
  g.moveTo(tx, ty); g.lineTo(tx - ah * Math.cos(ang - spread), ty - ah * Math.sin(ang - spread));
  g.moveTo(tx, ty); g.lineTo(tx - ah * Math.cos(ang + spread), ty - ah * Math.sin(ang + spread));
  g.beginFill(color, 1).drawCircle(fx, fy, 7).endFill();
  return { tx, ty };
}

function _tpClear() {
  if (_tpContainer) {
    try { _tpContainer.parent?.removeChild(_tpContainer); } catch (_e) {}
    try { _tpContainer.destroy({ children: true }); } catch (_e) {}
    _tpContainer = null;
  }
}

function _tpBuild() {
  _tpClear();
  if (!game.user?.isGM || !canvas?.ready || !canvas.scene) return;
  const scene = canvas.scene;
  const regions = scene.regions;
  if (!regions?.size) return;

  const container = new PIXI.Container();
  container.eventMode = "none";
  const g = new PIXI.Graphics();
  container.addChild(g);
  const labelStyle = new PIXI.TextStyle({
    fontFamily: "Signika, sans-serif", fontSize: 20, fontWeight: "bold",
    fill: "#ffffff", stroke: "#000000", strokeThickness: 4, align: "left",
  });

  let any = false;
  for (const region of regions) {
    for (const b of (region.behaviors ?? [])) {
      if (b?.disabled) continue;
      if (String(b?.type ?? "") !== "teleportToken") continue;
      const destUuid = String(b?.system?.destination ?? "").trim();
      if (!destUuid) continue;
      let dest = null; try { dest = fromUuidSync(destUuid); } catch (_e) {}
      if (!dest) continue;                       // broken / from another world
      if (dest.id === region.id && dest.parent === scene) continue; // self-teleport — skip
      const from = _tpRegionCenter(region);
      if (!from) continue;
      const color = _tpColorFor(region.id);

      if (dest.parent === scene) {
        // Same scene — a line to the destination center.
        const to = _tpRegionCenter(dest);
        if (!to) continue;
        _tpDrawArrow(g, from, to, color);
        any = true;
      } else {
        // Another scene — a stub arrow + label.
        const end = _tpDrawArrow(g, from, { x: from.x + 70, y: from.y - 70 }, color);
        const sceneName = dest.parent?.name ?? "?";
        const lbl = new TP_TextClass(`→ ${sceneName}: ${dest.name ?? "?"}`, labelStyle);
        lbl.eventMode = "none";
        lbl.anchor.set(0, 0.5);
        lbl.position.set(end.tx + 6, end.ty);
        container.addChild(lbl);
        any = true;
      }
    }
  }

  if (!any) { try { container.destroy({ children: true }); } catch (_e) {} return; }
  const layer = canvas.interface ?? canvas.controls ?? canvas.stage;
  try { layer.addChild(container); _tpContainer = container; }
  catch (_e) { try { container.destroy({ children: true }); } catch (_e2) {} }
}

function _tpIsAltKey(ev) {
  return ev.key === "Alt" || ev.code === "AltLeft" || ev.code === "AltRight";
}
function _tpOnKeyDown(ev) {
  if (!_tpIsAltKey(ev) || _tpAltActive) return; // guard against keydown auto-repeat
  _tpAltActive = true;
  _tpBuild();
}
function _tpOnKeyUp(ev) {
  if (!_tpIsAltKey(ev)) return;
  _tpAltActive = false;
  _tpClear();
}
function _tpOnBlur() { _tpAltActive = false; _tpClear(); } // Alt+Tab etc. — do not leave it hanging

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  document.addEventListener("keydown", _tpOnKeyDown, true);
  document.addEventListener("keyup", _tpOnKeyUp, true);
  window.addEventListener("blur", _tpOnBlur);
});
// Scene change — the old container lived on the previous canvas; reset the reference/state.
Hooks.on("canvasReady", () => { _tpAltActive = false; _tpClear(); });

/* ═══════════════════════════════════════════════════════════════════════════
 * VIDEO TILE: skipping playbacks (pauses between showings)
 * Flag flags[adm-levels].videoSkip = "N" | "N-M": after each full
 * playback the video tile is hidden for N (or random N..M) durations
 * of the clip, then shown and played again. Example: birds fly by,
 * pause for 1–2 fly-bys, again. Purely client-side visual (no document writes):
 * playback is NOT touched (robust to core's refresh→refreshVideo), loop iterations
 * are caught via video.currentTime (timeupdate), the pause is held by hiding mesh.visible.
 * ═══════════════════════════════════════════════════════════════════════════ */

const _skipCtrls = new Map(); // tileId -> VideoSkipController

// ── Random clip pool (wildcard) ──
// Players do NOT have FILES_BROWSE → only the GM resolves the wildcard and sends the chosen file over the socket.
const _poolCache = new Map(); // pattern -> {files, ts}
async function _resolvePool(pattern) {
  if (!pattern || !pattern.includes("*")) return [];
  const hit = _poolCache.get(pattern);
  if (hit && (Date.now() - hit.ts) < 60000) return hit.files;
  let files = [];
  try {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    for (const source of ["data", "public"]) {
      try {
        const r = await FP.browse(source, pattern, { wildcard: true });
        const vids = (r?.files ?? []).filter(f => foundry.helpers?.media?.VideoHelper?.hasVideoExtension?.(f));
        if (vids.length) { files = vids; break; }
      } catch (_) { /* next source */ }
    }
  } catch (_) { /* ignore */ }
  _poolCache.set(pattern, { files, ts: Date.now() });
  return files;
}
function _pickPoolNext(files, current) {
  if (!files?.length) return null;
  if (files.length === 1) return files[0];
  let f, guard = 0;
  do { f = files[Math.floor(Math.random() * files.length)]; } while (f === current && guard++ < 8);
  return f;
}
// Folder of the main file → wildcard "folder/*" (for the "pool from this folder" checkbox).
function _folderPattern(src) {
  const p = String(src ?? "").split("?")[0];
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash > 0 ? p.slice(0, slash) + "/*" : null;
}
const _POOL_MSG = `module.${MODULE_ID}`;
function _poolBroadcast(tileId, src) {
  try { game.socket?.emit(_POOL_MSG, { t: "vpool", id: tileId, src }); } catch (_) {}
}
Hooks.once("ready", () => {
  game.socket?.on(_POOL_MSG, (data) => {
    if (data?.t !== "vpool" || !data.id) return;
    const c = _skipCtrls.get(data.id);
    if (c) c.nextSrc = data.src;   // applied in its own show phase (or immediately, if the pool has no pauses)
  });

  // Guard: when swapping a pool clip (v.src changed, load() has not yet loaded metadata) video.duration=NaN.
  // Core Tile._refreshVideo → game.video.play does currentTime=clamp(offset,0,NaN)=NaN → crash
  // (foundry.mjs:166195). Skip _refreshVideo while the duration is not finite — core will replay later.
  const _guard = function (wrapped, ...args) {
    try { const v = game.video?.getVideoSource?.(this.texture); if (v && !Number.isFinite(v.duration)) return; } catch (_) {}
    return wrapped.apply(this, args);
  };
  try {
    if (globalThis.libWrapper?.register) {
      libWrapper.register(MODULE_ID, "foundry.canvas.placeables.Tile.prototype._refreshVideo", _guard, "MIXED");
    } else {
      const proto = foundry.canvas?.placeables?.Tile?.prototype;
      if (proto?._refreshVideo && !proto.__admRefreshVideoGuarded) {
        const orig = proto._refreshVideo;
        proto._refreshVideo = function (...a) {
          const v = game.video?.getVideoSource?.(this.texture);
          if (v && !Number.isFinite(v.duration)) return;
          return orig.apply(this, a);
        };
        proto.__admRefreshVideoGuarded = true;
      }
    }
  } catch (e) { console.warn("[adm-levels] _refreshVideo NaN-guard failed:", e?.message ?? e); }
});

// "N" -> {min:N,max:N}; "N-M" -> {min,max}; otherwise/empty/0 -> null (disabled).
function _parseVideoSkip(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return null;
  let a = parseInt(m[1], 10);
  let b = m[2] != null ? parseInt(m[2], 10) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b < a) { const t = a; a = b; b = t; }
  if (b <= 0) return null; // max 0 → no pauses = disabled
  return { min: Math.max(0, a), max: b };
}

class VideoSkipController {
  constructor(tile, cfg, pool) {
    this.tile = tile;
    this.hasSkip = !!cfg;
    this.min = cfg?.min ?? 1; this.max = cfg?.max ?? 1;
    this.pool = pool || null;                            // wildcard pattern of random clips or null
    this.nextSrc = null;                                 // the prepared next clip (GM pick / broadcast)
    this.curSrc = tile?.document?.texture?.src ?? null;  // the currently shown clip
    this.hidden = false;        // are we hiding the tile right now?
    this.showing = true;        // the current loop iteration is a "show" (otherwise a "skip")
    this.skipsLeft = 0;
    this._lastTime = 0;
    this._retryTimer = null; this._retries = 0;
    this._boundVideo = null;
    // Loop restarts are caught per PRESENTED FRAME (requestVideoFrameCallback): `timeupdate` comes
    // only ~4 times a second, so the tile used to appear up to 0.25 s into the clip (birds popping in
    // mid-flight) and the start of a skipped round flashed before hiding. `timeupdate` stays as a
    // fallback when frame callbacks do not arrive.
    this._rvfcHandle = null;    // pending frame callback id
    this._rvfcAt = 0;           // performance.now() of the last frame callback
    this._revealPending = false; // a new pool clip was swapped in while hidden: show it on its first frame
    this._revealTimer = null;
    this._destroyed = false;
    this._onTimeUpdate = this._onTimeUpdate.bind(this);
    this._onFrame = this._onFrame.bind(this);
    this._attach();
  }
  get video() {
    const el = this.tile?.sourceElement;
    return (el && el.tagName === "VIDEO") ? el : null;
  }
  update(cfg, pool) {
    this.hasSkip = !!cfg; this.min = cfg?.min ?? 1; this.max = cfg?.max ?? 1;
    if ((pool || null) !== this.pool) { this.pool = pool || null; this.nextSrc = null; this._gmPrepareNext(); }
  }
  _attach() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    const v = this.video;
    if (!v) { // the video texture is still loading — a short retry
      if (this._retries++ < 40) this._retryTimer = setTimeout(() => this._attach(), 150);
      return;
    }
    if (this._boundVideo === v) return;
    if (this._boundVideo) {
      this._boundVideo.removeEventListener("timeupdate", this._onTimeUpdate);
      this._cancelFrame();
    }
    this._boundVideo = v;
    this._lastTime = v.currentTime || 0;
    this._clearReveal();
    this.showing = true; this.hidden = false; this._applyVis(); // iteration start — show
    // Playback is NOT touched (video.loop stays under Foundry): refresh propagates
    // refreshVideo and would reset our loop — so the iteration is caught BY TIME, not by 'ended'.
    v.addEventListener("timeupdate", this._onTimeUpdate);
    this._armFrame();
    this.curSrc = this.tile?.document?.texture?.src ?? this.curSrc; // baseline after (re)draw
    this._gmPrepareNext();                                          // prepare a clip for the 1st rotation
  }
  _armFrame() {
    const v = this._boundVideo;
    if (this._destroyed || !v || this._rvfcHandle != null || typeof v.requestVideoFrameCallback !== "function") return;
    try { this._rvfcHandle = v.requestVideoFrameCallback(this._onFrame); } catch (_) { this._rvfcHandle = null; }
  }
  _cancelFrame() {
    const v = this._boundVideo;
    if (this._rvfcHandle != null) { try { v?.cancelVideoFrameCallback?.(this._rvfcHandle); } catch (_) {} }
    this._rvfcHandle = null;
  }
  // A frame of the clip has been presented: the exact place to notice a loop restart.
  _onFrame(_now, meta) {
    this._rvfcHandle = null;
    const v = this._boundVideo;
    if (this._destroyed || !v) return;
    this._rvfcAt = performance.now();
    this._step(Number(meta?.mediaTime ?? v.currentTime) || 0);
    this._armFrame();
  }
  _onTimeUpdate() {
    const v = this.video; if (!v || v !== this._boundVideo) return;
    if (this._rvfcAt && (performance.now() - this._rvfcAt) < 1000) return; // frame callbacks drive it
    this._step(v.currentTime || 0);
  }
  _step(t) {
    if (this._revealPending) {                      // the swapped clip has its first frame — show it now
      const v = this._boundVideo;
      if (v && v.readyState >= 2) { this._clearReveal(); this._show(); }
      this._lastTime = t;
      return;
    }
    if (t + 0.05 < this._lastTime) this._onWrap(); // time went backwards → the loop started a new round
    this._lastTime = t;
  }
  _onWrap() {
    if (this.showing) {
      const skip = this.hasSkip ? (this.min + Math.floor(Math.random() * (this.max - this.min + 1))) : 0;
      if (skip > 0) { this.showing = false; this.skipsLeft = skip; this._hide(); }
      else if (this.pool) this._startShow();       // no pauses but with a pool — rotate on every iteration
    } else if (--this.skipsLeft <= 0) {
      this._startShow();
    }
  }
  // Start of a new show period. With a pool the next clip is swapped in WHILE THE TILE IS STILL
  // HIDDEN and shown on its first presented frame — showing first and swapping after flashed the
  // start of the old clip. Without a swap the tile is shown right away (the loop just restarted).
  _startShow() {
    this.showing = true;
    const swapped = this.pool ? this._applyNext() : false;
    if (swapped) {
      this._hide();
      this._revealPending = true;
      if (this._revealTimer) clearTimeout(this._revealTimer);
      // Safety: never keep the tile hidden if the first frame is not reported (1.5 s).
      this._revealTimer = setTimeout(() => {
        this._revealTimer = null;
        if (this._revealPending && !this._destroyed) { this._revealPending = false; this._show(); }
      }, 1500);
    } else {
      this._show();
    }
    if (this.pool) this._gmPrepareNext();
  }
  _clearReveal() {
    this._revealPending = false;
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
  }
  _gmPrepareNext() {  // GM: resolve the pool (cached) → random ≠ current → nextSrc + broadcast to all
    if (!this.pool || !game.user?.isGM) return;
    const tileId = this.tile?.id;
    _resolvePool(this.pool).then((files) => {
      const next = _pickPoolNext(files, this.curSrc);
      if (next) { this.nextSrc = next; _poolBroadcast(tileId, next); }
    }).catch(() => {});
  }
  _applyNext() {  // swap the clip on the SAME video element (without recreating the texture/listener)
    // nextSrc is NOT cleared: the player keeps the GM's last pick and re-applies it on his own iteration
    // (no-op if the same) — less desync. loop is NOT touched: it stays under the document/Foundry.
    // → true when the clip was actually swapped.
    const src = this.nextSrc;
    const v = this.video; if (!src || !v || src === this.curSrc) return false;
    this.curSrc = src;
    this._cancelFrame();   // a callback still pending for the OLD clip must not count as the new first frame
    try {
      v.src = foundry.utils.getRoute(src);
      v.load();
      const p = v.play?.(); if (p?.catch) p.catch(() => {});
    } catch (_) {}
    this._lastTime = 0; // src resets currentTime to 0 → so this is not counted as a false iteration
    this._armFrame();
    return true;
  }
  _hide() { this.hidden = true; this._applyVis(); }
  _show() { this.hidden = false; this._applyVis(); }
  _applyVis() {
    const m = this.tile?.mesh; if (!m) return;
    // A tile selected by the GM is always visible (editing). Pause → hide. Show → do NOT force true,
    // but yield the tile's natural visibility (respecting hidden/levels/layers/other modules).
    if (this.tile?.controlled) { m.visible = true; return; }
    m.visible = this.hidden ? false : (this.tile?.visible !== false);
  }
  // During a pause keep hiding after refreshTile (Foundry's _refreshState would restore mesh.visible=this.visible).
  // While showing do NOT touch it — Foundry governs visibility (compatibility with levels/MATT/layers etc.).
  assert() {
    const v = this.video;
    if (v && this._boundVideo !== v) { this._retries = 0; this._attach(); return; }
    if (this.hidden && this.tile?.mesh && !this.tile.controlled) this.tile.mesh.visible = false;
  }
  destroy() {
    this._destroyed = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._clearReveal();
    this._cancelFrame();
    if (this._boundVideo) this._boundVideo.removeEventListener("timeupdate", this._onTimeUpdate);
    this._boundVideo = null;
    if (this.tile?.mesh) this.tile.mesh.visible = this.tile?.visible !== false; // restore natural visibility
  }
}

function _ensureSkip(tile) {
  if (!tile?.document) return;
  // Video tiles only: otherwise get video is always null → retry storm + an eternal controller.
  const src = tile.document.texture?.src;
  const isVideo = !!src && foundry.helpers?.media?.VideoHelper?.hasVideoExtension?.(src);
  const cfg = isVideo ? _parseVideoSkip(tile.document.getFlag?.(MODULE_ID, FLAG_VIDEO_SKIP)) : null;
  // The videoPool checkbox → pool = ALL videos from the FOLDER of the main file (texture.src → "folder/*").
  const pool = (isVideo && tile.document.getFlag?.(MODULE_ID, FLAG_VIDEO_POOL)) ? _folderPattern(src) : null;
  const existing = _skipCtrls.get(tile.id);
  if (!cfg && !pool) { if (existing) { existing.destroy(); _skipCtrls.delete(tile.id); } return; }
  if (existing) { existing.update(cfg, pool); existing.assert(); }
  else _skipCtrls.set(tile.id, new VideoSkipController(tile, cfg, pool));
}
function _teardownSkip(tileId) {
  const c = _skipCtrls.get(tileId);
  if (c) { c.destroy(); _skipCtrls.delete(tileId); }
}

Hooks.on("canvasReady", () => {
  for (const c of _skipCtrls.values()) c.destroy();
  _skipCtrls.clear();
  for (const tile of (canvas.tiles?.placeables ?? [])) _ensureSkip(tile);
});
Hooks.on("drawTile", (tile) => _ensureSkip(tile));
Hooks.on("refreshTile", (tile) => { const c = _skipCtrls.get(tile?.id); if (c) c.assert(); });
Hooks.on("controlTile", (tile) => { const c = _skipCtrls.get(tile?.id); if (c) c.assert(); }); // select/deselect — re-apply visibility immediately
Hooks.on("updateTile", (tileDoc) => {
  const t = tileDoc?.object ?? canvas.tiles?.get?.(tileDoc.id);
  if (t) _ensureSkip(t);
});
Hooks.on("deleteTile", (tileDoc) => _teardownSkip(tileDoc?.id));

// The "Skip playbacks" field in the tile config (after the "Video Options" block).
Hooks.on("renderTileConfig", (app, htmlOrEl) => {
  const element = htmlOrEl instanceof HTMLElement
    ? htmlOrEl
    : (htmlOrEl?.[0] instanceof HTMLElement ? htmlOrEl[0] : (htmlOrEl?.element ?? null));
  if (!element || element.querySelector("[data-adm-video-skip]")) return;
  // The field is for video tiles only (the feature is inactive for images).
  const tsrc = app.document?.texture?.src;
  if (!tsrc || !foundry.helpers?.media?.VideoHelper?.hasVideoExtension?.(tsrc)) return;

  const cur = foundry.utils.getProperty(app.document, `flags.${MODULE_ID}.${FLAG_VIDEO_SKIP}`) ?? "";
  const curPool = foundry.utils.getProperty(app.document, `flags.${MODULE_ID}.${FLAG_VIDEO_POOL}`) ?? "";
  const esc = foundry.utils.escapeHTML;
  const L = (k) => game.i18n.localize(`ADM_LEVELS.videoSkip.${k}`);
  const icon = (k) => `<i class="fa-solid fa-circle-info" data-tooltip="${esc(L(k))}" style="opacity:.6;cursor:help;margin-left:4px;"></i>`;
  const html = `
    <fieldset data-adm-video-skip>
      <legend>${esc(L("legend"))}</legend>
      <div class="form-group">
        <label>${esc(L("label"))}${icon("hint")}</label>
        <div class="form-fields">
          <input type="text" name="flags.${MODULE_ID}.${FLAG_VIDEO_SKIP}" value="${esc(String(cur))}" placeholder="${esc(L("placeholder"))}">
        </div>
      </div>
      <div class="form-group">
        <label>${esc(L("poolLabel"))}${icon("poolHint")}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.${MODULE_ID}.${FLAG_VIDEO_POOL}" ${curPool ? "checked" : ""}>
        </div>
      </div>
    </fieldset>`;

  const anchor = element.querySelector('fieldset[data-video-options]');
  if (anchor) anchor.insertAdjacentHTML("afterend", html);
  else {
    const footer = element.querySelector("footer, .form-footer");
    if (footer) footer.insertAdjacentHTML("beforebegin", html);
    else element.insertAdjacentHTML("beforeend", html);
  }
});
