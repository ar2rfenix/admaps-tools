// scripts/tools/wall-chain-click.mjs
// ADMaps Tools sub-module: draw walls with clicks and freehand drags (one hand, nothing held).
//
// A toggle in the wall tools. While it is on and a wall tool (walls / terrain / invisible /
// ethereal / doors / secret / window / clone) is active:
//   • CLICK: the first click sets the start point, every next click creates a wall from the
//     previous point to the clicked one and continues from there — the chain never ends by itself.
//     A click near an existing wall endpoint lands exactly on it (no gaps for vision);
//   • DRAG (button held): the stroke starts where the button is pressed (see below for the chain
//     end) and is traced through GRID INTERSECTIONS only: every
//     corner the cursor passes close to becomes the next wall point. Steps go one cell at a time
//     (a side or a diagonal — a fast move that skips corners is filled with one-cell steps hugging
//     the cursor line), but ONE WALL covers a whole straight run: while the direction does not
//     change the last wall is extended, a turn starts a new wall. Going back over a run or over
//     an existing wall draws nothing (no duplicates, nothing is deleted either). Releasing keeps
//     the chain open from the last vertex. Gridless scenes keep the stock drag (one straight wall);
//   • SHIFT + CLICK = a free point exactly under the cursor (no grid; an existing wall endpoint
//     nearby still wins). With Shift held a press never becomes a trace: a small slip of the
//     mouse is still a click at the pressed point;
//   • a drag pressed next to the chain end (within half a cell) CONTINUES the chain from it, so
//     tracing goes on after Shift-clicked points; from an off-grid point it first reaches the
//     corner of that cell nearest to the cursor, and the corner right next to the point is
//     skipped until the cursor has moved away from it (no stubs from a slight move);
//   • existing walls are not interactive (their endpoints can't be grabbed or dragged, they
//     can't be selected) — the stock behaviour comes back on the Select tool;
//   • right click (or Esc, after Foundry has closed any open window) closes the chain: the pending
//     segment disappears, nothing that was already created is touched. The next click starts a
//     new chain. Leaving the wall tools or the layer closes it too.
//   • after the user closes a chain a «+ Region» button offers a region from its outline
//     (see wall-chain-region.mjs); Ctrl+Z right after that operation reverts it.
// Turn the toggle off to get the stock wall behaviour back (endpoint dragging, selection).
//
// Implementation: libWrapper on the walls layer (click / right-click / drag start-move-drop-
// cancel / preview clearing / undo / dismiss key / activate / deactivate). The chain point is the
// layer's own `_last.point` — the same field the stock Ctrl-chaining uses, so the gridless drag
// and undo stay in sync. The pending segment is a stock Wall placeable in the layer's preview
// container, followed by the cursor from a ticker (there is no layer mouse-move callback outside
// a drag). Foundry fires the layer click on pointer DOWN, before it knows whether a drag follows,
// so a clicked wall is committed on pointer UP (window listener) and only if no drag started.

import { panelFloor, wallOnFloor } from "./floor-range.mjs";
import {
  regionInit, regionOffer, regionHide, regionCancel, regionClick,
  regionModeActive, regionOffered, regionUndo, regionForget,
} from "./wall-chain-region.mjs";

const MODULE_ID = "adm-levels";
const WALL_TOOLS = new Set(["walls", "terrain", "invisible", "ethereal", "doors", "secret", "window", "clone"]);
const TRACE_CAPTURE = 0.35;   // × grid size: how close the cursor must pass to a vertex to commit it
const ENDPOINT_MAGNET = 0.2;  // × grid size: a click this close to an existing wall endpoint lands on it
const EPS = 0.5;              // px: collinearity / coverage tolerance

let _on = false;            // toggle state (per client, in memory)
let _preview = null;        // pending-segment Wall placeable
let _ticker = null;         // cursor follower
let _dragging = false;      // a drag workflow is in progress
let _prevEventMode = null;  // walls container eventMode before we disabled interaction
let _seg = null;            // current straight run of the trace: { from, end, dir, doc, q }
let _runs = [];             // every run of the current stroke (their docs may not be in the scene yet)
let _pendingClick = null;   // wall promised by the last pointer-down: { last, pt } (committed on pointer-up)
let _upHandler = null;
let _tracing = false;       // a grid trace drag is in progress
let _hold = null;           // grid corner next to an off-grid start: skipped until the cursor leaves its capture zone
let _toolSeen = null;       // last tool name handled by _onToolChange
let _path = [];             // points of the open chain in drawing order (the region outline)

const _layer = () => canvas?.walls ?? null;
const _wallToolActive = () => WALL_TOOLS.has(String(game.activeTool ?? ""));
const _active = (layer) => _on && !!game.user?.isGM && layer?.active && _wallToolActive();
const _same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const _gridSize = () => Number(canvas.dimensions?.size) || 100;

/** Wall defaults for the active tool — a copy of the layer's private #getWallDataFromActiveTool. */
function _wallDataFromTool(layer, tool) {
  if (tool === "clone" && layer?._cloneType) return foundry.utils.deepClone(layer._cloneType);
  const S = CONST.WALL_SENSE_TYPES;
  const data = { light: S.NORMAL, sight: S.NORMAL, sound: S.NORMAL, move: S.NORMAL };
  switch (tool) {
    case "invisible": data.sight = data.light = data.sound = S.NONE; break;
    case "terrain": data.sight = data.light = data.sound = S.LIMITED; break;
    case "ethereal": data.move = data.sound = S.NONE; break;
    case "doors": data.door = CONST.WALL_DOOR_TYPES.DOOR; break;
    case "secret": data.door = CONST.WALL_DOOR_TYPES.SECRET; break;
    case "window": {
      const d = canvas.dimensions.distance;
      data.sight = data.light = S.PROXIMITY;
      data.threshold = { light: 2 * d, sight: 2 * d, attenuation: true };
      break;
    }
  }
  return data;
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

/** Click snapping: an existing wall endpoint within the magnet radius wins, otherwise the layer's
 *  own snapping (centres, vertices, corners, side midpoints; Shift = none). Only walls of the floor
 *  picked in the Levels panel pull (23.09.2026: drawing the upper floor snapped to the walls below). */
function _snapClick(layer, point, snap) {
  let best = null, bd = _gridSize() * ENDPOINT_MAGNET;
  const floor = panelFloor();
  for (const w of layer.placeables) {
    if (!wallOnFloor(w.document, floor)) continue;
    const c = w.document?.c;
    if (!c) continue;
    for (const [x, y] of [[c[0], c[1]], [c[2], c[3]]]) {
      const d = Math.hypot(point.x - x, point.y - y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
  }
  return best ?? layer._getWallEndpointCoordinates(point, { snap });
}

/** Trace snapping — grid intersections only. */
function _snapVertex(point) {
  const p = canvas.grid.getSnappedPoint({ x: point.x, y: point.y }, { mode: CONST.GRID_SNAPPING_MODES.VERTEX });
  return [Math.round(p.x), Math.round(p.y)];
}

/** Whether `p` lies on the segment a–b (within EPS). */
function _onSegment(a, b, p) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len = Math.hypot(abx, aby);
  if (len < EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]) <= EPS;
  if (Math.abs(abx * (p[1] - a[1]) - aby * (p[0] - a[0])) / len > EPS) return false;
  const t = (abx * (p[0] - a[0]) + aby * (p[1] - a[1])) / (len * len);
  return t >= -EPS / len && t <= 1 + EPS / len;
}

/** An existing wall of the floor being edited already runs over the step `from → to` (a wall of
 *  another floor under the same line must not stop the trace from drawing this floor's wall). */
function _coveredByWall(from, to) {
  const floor = panelFloor();
  for (const w of canvas.scene?.walls ?? []) {
    if (!wallOnFloor(w, floor)) continue;
    const c = w.c;
    const a = [c[0], c[1]], b = [c[2], c[3]];
    if (_onSegment(a, b, from) && _onSegment(a, b, to)) return true;
  }
  return false;
}

/** Direction of `a → b` as a rounded unit vector (equal for collinear same-way steps). */
function _dirOf(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [Math.round((dx / len) * 1000), Math.round((dy / len) * 1000)];
}
const _sameDir = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Vertices between `from` and `to` in ONE-CELL steps (square grid): a fast move can skip
 *  corners, and a traced wall must never be longer than a cell (straight) or a cell diagonal.
 *  At every step the candidate (diagonal / horizontal / vertical) nearest to the cursor line wins,
 *  a tie goes to the diagonal. An off-grid start (a free point, a clicked point, an undo) first
 *  reaches the corner of its own cell nearest to the target. Other grids: the target vertex as is. */
function _oneCellSteps(from, to, pos, gs) {
  if (canvas.grid?.type !== CONST.GRID_TYPES.SQUARE) return [to];
  const onLattice = (p) => Math.abs(p[0] / gs - Math.round(p[0] / gs)) < 1e-6
    && Math.abs(p[1] / gs - Math.round(p[1] / gs)) < 1e-6;
  const out = [];
  let start = from;
  if (!onLattice(from)) {
    let bd = Infinity;
    for (const gx of new Set([Math.floor(from[0] / gs), Math.ceil(from[0] / gs)])) {
      for (const gy of new Set([Math.floor(from[1] / gs), Math.ceil(from[1] / gs)])) {
        const d = Math.hypot(gx * gs - to[0], gy * gs - to[1]);
        if (d < bd) { bd = d; start = [gx * gs, gy * gs]; }
      }
    }
    if (_same(start, to)) return [to];
    out.push(start);
  }
  const tx = Math.round(to[0] / gs), ty = Math.round(to[1] / gs);
  let cx = Math.round(start[0] / gs), cy = Math.round(start[1] / gs);
  if (Math.abs(tx - cx) <= 1 && Math.abs(ty - cy) <= 1) { out.push(to); return out; }
  const ax = start[0], ay = start[1], bx = pos.x, by = pos.y;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const offLine = (px, py) => Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
  let guard = 0;
  while ((cx !== tx || cy !== ty) && guard++ < 1024) {
    const sx = Math.sign(tx - cx), sy = Math.sign(ty - cy);
    const cands = [];
    if (sx && sy) cands.push([cx + sx, cy + sy]);
    if (sx) cands.push([cx + sx, cy]);
    if (sy) cands.push([cx, cy + sy]);
    let best = cands[0], bd = Infinity;
    for (const c of cands) {
      const d = offLine(c[0] * gs, c[1] * gs);
      if (d < bd - 1e-6) { bd = d; best = c; }
    }
    cx = best[0]; cy = best[1];
    out.push([cx * gs, cy * gs]);
  }
  out[out.length - 1] = to;   // land exactly on the snapped vertex
  return out;
}

/* -------------------------------------------- */
/*  Walls                                       */
/* -------------------------------------------- */

/** Create a chain wall from `from` to `to` with the active tool's defaults → the document (null on failure). */
function _createWall(layer, from, to) {
  const data = _wallDataFromTool(layer, game.activeTool);
  data.c = [from[0], from[1], to[0], to[1]];
  return CONFIG.Wall.documentClass.create(data, { parent: canvas.scene, admWallChain: true })
    .catch((e) => { console.warn("[adm-levels] wall chain: create", e); return null; });
}

/** One trace step `from → to`: while the direction does not change, the current straight run
 *  is EXTENDED (one wall per straight run, not per cell); a turn starts a new wall; a step that
 *  is already covered by the run or by an existing wall draws nothing. Updates are chained behind
 *  the run's create so a fast stroke never updates a wall that does not exist yet. */
function _traceStep(layer, from, to) {
  const dir = _dirOf(from, to);
  const covers = (r) => _onSegment(r.from, r.end, from) && _onSegment(r.from, r.end, to);
  if (_runs.some(covers)) return;                        // this stroke already drew over the step (any direction)
  if (_coveredByWall(from, to)) return;                  // an existing wall runs over the step
  const seg = _seg;
  if (seg && _sameDir(seg.dir, dir) && _onSegment(seg.from, seg.end, from)) {   // forward past the run's end — extend
    seg.end = to;
    const c = [seg.from[0], seg.from[1], to[0], to[1]];
    seg.q = seg.q.then(() => seg.doc?.update({ c }, { admWallChain: true }))
      .catch((e) => { console.warn("[adm-levels] wall chain: extend", e); if (_seg === seg) _seg = null; });
    return;
  }
  const next = { from, end: to, dir, doc: null, q: null };
  next.q = _createWall(layer, from, to).then((doc) => {
    next.doc = doc;
    if (doc) return;
    if (_seg === next) _seg = null;                      // create refused — do not keep "extending" nothing
    _runs = _runs.filter((r) => r !== next);
  });
  _seg = next;
  _runs.push(next);
}

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

function _stopPreview() {
  if (_ticker) { try { canvas.app?.ticker?.remove(_ticker); } catch (_e) {} _ticker = null; }
  if (_preview) {
    try { if (!_preview._destroyed) _preview.destroy({ children: true }); } catch (_e) {}
    _preview = null;
  }
}

/** Pending segment from `from` to the cursor. */
function _startPreview(layer, from) {
  _stopPreview();
  try {
    const data = _wallDataFromTool(layer, game.activeTool);
    data.c = [from[0], from[1], from[0], from[1]];
    const doc = new CONFIG.Wall.documentClass(data, { parent: canvas.scene });
    const wall = new layer.constructor.placeableClass(doc);
    doc._object = wall;
    _preview = wall;
    Promise.resolve(wall.draw()).then(() => {
      if (_preview !== wall || wall._destroyed) return;
      layer.preview.addChild(wall);
    }).catch((e) => console.warn("[adm-levels] wall chain: preview", e));
    _ticker = () => {
      if (!_preview || _preview._destroyed || _preview !== wall) return;
      const c = wall.document.c;
      const dest = _tracing
        ? _snapVertex(canvas.mousePosition)
        : _snapClick(layer, canvas.mousePosition, !game.keyboard?.isModifierActive?.("SHIFT"));
      if (c[2] === dest[0] && c[3] === dest[1]) return;
      wall.document.updateSource({ c: [c[0], c[1], dest[0], dest[1]] });
      wall.refresh();
    };
    canvas.app.ticker.add(_ticker);
  } catch (e) { console.warn("[adm-levels] wall chain: preview start", e); _stopPreview(); }
}

/** Move the pending segment's start (a trace commits vertices without recreating the preview). */
function _movePreviewStart(layer, from) {
  if (!_preview || _preview._destroyed) { _startPreview(layer, from); return; }
  const c = _preview.document.c;
  _preview.document.updateSource({ c: [from[0], from[1], c[2], c[3]] });
  _preview.refresh();
}

/* -------------------------------------------- */
/*  Chain                                       */
/* -------------------------------------------- */

/** Outline: append a point (consecutive duplicates skipped). */
function _pathAdd(p) {
  if (p && !_same(_path[_path.length - 1], p)) _path.push([p[0], p[1]]);
}

/** Outline after an undo: back to the point the chain now continues from. */
function _pathTrimTo(p) {
  while (_path.length && !_same(_path[_path.length - 1], p)) _path.pop();
  if (!_path.length) _path.push([p[0], p[1]]);
}

/** A new chain begins: fresh outline, no region offer, no region undo. */
function _chainStarts() {
  _path = [];
  regionHide();
  regionForget();
}

/** Close the chain: drop the pending segment, keep everything already created.
 *  `offer` — closed by the user (right click / Esc): offer a region from the outline. */
function _cancelChain(layer, { offer = false } = {}) {
  if (offer) regionOffer(_path); else regionHide();
  _path = [];
  _stopPreview();
  _seg = null;
  _runs = [];
  _pendingClick = null;
  _hold = null;
  if (layer) { layer._last = { point: null }; layer._chain = false; }
}

/** Drag tracing: commit the grid vertex the cursor is close to and continue from it. */
function _traceTo(layer, pos) {
  const last = layer._last?.point;
  if (!last || !pos) return;
  const v = _snapVertex(pos);
  if (_same(v, last)) return;
  const gs = _gridSize();
  if (_hold) {
    // A trace started from an off-grid point: the cursor still sits next to a corner, and a tiny
    // move must not draw a stub to it. The corner counts again once the cursor has left its zone.
    if (Math.hypot(pos.x - _hold[0], pos.y - _hold[1]) <= gs * TRACE_CAPTURE) return;
    _hold = null;
  }
  if (Math.hypot(pos.x - v[0], pos.y - v[1]) > gs * TRACE_CAPTURE) return;
  let from = last;
  for (const p of _oneCellSteps(last, v, pos, gs)) {
    if (_same(p, from)) continue;
    _traceStep(layer, from, p);
    _pathAdd(p);
    from = p;
  }
  layer._last = { point: from };
  _movePreviewStart(layer, from);
}

/** Pointer released: a pointer-down that did not turn into a drag commits its clicked wall. */
function _onPointerUp(ev) {
  if (ev.button !== 0) return;
  const pc = _pendingClick;
  _pendingClick = null;
  if (!pc || _dragging) return;
  const layer = _layer();
  if (!layer || !_active(layer)) return;
  if (!_same(layer._last?.point, pc.pt)) return;     // the chain moved on meanwhile
  if (pc.data?.cancelled) {                          // Esc while the button was held: take the press back
    if (!pc.last) { _cancelChain(layer); return; }
    layer._last = { point: pc.last };
    _startPreview(layer, pc.last);
    return;
  }
  if (pc.last) {
    _pathAdd(pc.last);
    void _createWall(layer, pc.last, pc.pt);
  }
  _pathAdd(pc.pt);
}

/* -------------------------------------------- */
/*  Mode                                        */
/* -------------------------------------------- */

/** Existing walls: inert while the mode is on AND a wall tool is active, interactive otherwise. */
function _applyInteraction(layer, { restore = false } = {}) {
  const objects = layer?.objects;
  if (!objects) return;
  if (_on && !restore && _wallToolActive()) {
    if (_prevEventMode === null) {
      // Never remember our own "none" as the stock value (a redrawn layer must get its default back).
      _prevEventMode = objects.eventMode === "none" ? (PIXI.EventSystem?.defaultEventMode ?? "auto") : objects.eventMode;
    }
    objects.eventMode = "none";
  } else if (_prevEventMode !== null) {
    objects.eventMode = _prevEventMode;
    _prevEventMode = null;
  }
}

/** The active tool of the walls control changed (Foundry reports it twice per change: for the
 *  prior tool and for the new one — the active tool is already the new one both times). */
function _onToolChange() {
  const layer = _layer();
  if (!layer || !_on) return;
  const tool = String(game.activeTool ?? "");
  if (tool === _toolSeen) return;
  _toolSeen = tool;
  _applyInteraction(layer);
  if (!_wallToolActive()) { _cancelChain(layer); return; }
  _seg = null;                                        // another wall type never extends the old run
  if (layer._last?.point && !_dragging) _startPreview(layer, layer._last.point);   // preview in the new type
}

function _setMode(on) {
  _on = !!on;
  const layer = _layer();
  if (!layer) return;
  if (_on) {
    _toolSeen = String(game.activeTool ?? "");
    _applyInteraction(layer);
    if (!_upHandler) {
      _upHandler = (ev) => { try { _onPointerUp(ev); } catch (e) { console.warn("[adm-levels] wall chain: pointer up", e); } };
      window.addEventListener("pointerup", _upHandler, true);
    }
  } else {
    _cancelChain(layer);
    regionForget();
    _applyInteraction(layer);
    if (_upHandler) { window.removeEventListener("pointerup", _upHandler, true); _upHandler = null; }
  }
  try { layer.releaseAll?.(); } catch (_e) {}
}

export const TOOL = {
  id: "wallChainClick",
  name: "ADM_LEVELS.settings.wallChainClick.name",
  hint: "ADM_LEVELS.settings.wallChainClick.hint",
  settingScope: "client",

  onReady({ isEnabled }) {
    if (!globalThis.libWrapper?.register) {
      console.warn("[adm-levels] wall chain: libWrapper missing — tool not installed.");
      return;
    }
    regionInit();
    const P = "foundry.canvas.layers.WallsLayer.prototype";
    const reg = (method, fn, kind) => {
      try { libWrapper.register(MODULE_ID, `${P}.${method}`, fn, kind); }
      catch (e) { console.warn(`[adm-levels] wall chain: wrapper ${method} failed`, e); }
    };

    // Pointer down: start the chain, or promise a segment (committed on pointer up unless a drag starts).
    reg("_onClickLeft", function (wrapped, event, ...rest) {
      if (!isEnabled() || !_active(this)) return wrapped(event, ...rest);
      wrapped(event, ...rest);
      try {
        if (regionModeActive()) {                                      // region pick: this press is ours
          if (event?.interactionData) event.interactionData.admRegionClick = true;
          regionClick();
          return;
        }
        const origin = event?.interactionData?.origin ?? canvas.mousePosition;
        const pt = _snapClick(this, origin, !event?.shiftKey);
        const last = this._last?.point ?? null;
        if (last && _same(last, pt)) return;                          // same point — nothing to draw
        if (!last) _chainStarts();
        _pendingClick = { last, pt, data: event?.interactionData ?? null };
        _seg = null;                                                   // a clicked wall is never extended
        this._last = { point: pt };
        _startPreview(this, pt);
      } catch (e) { console.warn("[adm-levels] wall chain: click", e); }
    }, "MIXED");

    // Right click: region pick → back to the button; open chain → close it (and offer a region);
    // a region button on screen → hide it.
    const closeStep = (layer) => {
      if (regionModeActive()) { regionCancel(); return true; }
      if (layer._last?.point && !_dragging) { _cancelChain(layer, { offer: true }); return true; }
      if (regionOffered() && !_dragging) { regionHide(); return true; }
      return false;
    };
    reg("_onClickRight", function (wrapped, event, ...rest) {
      if (isEnabled() && _active(this) && closeStep(this)) return;
      return wrapped(event, ...rest);
    }, "MIXED");

    // Ctrl+Z right after a region operation reverts that operation instead of a wall.
    reg("_onUndoKey", function (wrapped, event, ...rest) {
      if (isEnabled() && _active(this) && regionUndo()) return true;
      return wrapped(event, ...rest);
    }, "MIXED");

    // Esc (Foundry's dismiss chain, after open windows): the same steps as the right click.
    reg("_onDismissKey", function (wrapped, event, ...rest) {
      if (isEnabled() && _active(this) && closeStep(this)) return true;
      return wrapped(event, ...rest);
    }, "MIXED");

    // The current straight run is gone or changed by someone else (undo, delete, manual edit) —
    // the next trace step starts a new wall instead of extending it.
    Hooks.on("deleteWall", (doc) => {
      if (_seg?.doc && _seg.doc.id === doc.id) _seg = null;
      _runs = _runs.filter((r) => r.doc?.id !== doc.id);
    });
    Hooks.on("updateWall", (doc, _changes, options) => {
      if (options?.admWallChain) return;
      if (_seg?.doc && _seg.doc.id === doc.id) _seg = null;
      _runs = _runs.filter((r) => r.doc?.id !== doc.id);   // its remembered coordinates are stale now
    });

    // Drag = trace through grid intersections from the pressed point (or from the chain end next
    // to it). With Shift held: still a click (the pointer-down promise is committed on release).
    // Gridless: the stock drag from the chain point. A trace drops the pointer-down promise.
    reg("_onDragLeftStart", function (wrapped, event, ...rest) {
      if (event?.interactionData?.admRegionClick) return;             // the press picked a region
      if (!isEnabled() || !_active(this)) return wrapped(event, ...rest);
      if (event.shiftKey || game.keyboard?.isModifierActive?.("SHIFT")) {
        event.interactionData.admShiftClick = true;
        return;
      }
      const pc = _pendingClick;
      _pendingClick = null;
      const before = pc ? pc.last : (this._last?.point ?? null);       // chain point before this press
      if (!before) _chainStarts();
      if (canvas.grid?.type === CONST.GRID_TYPES.GRIDLESS) {
        _dragging = true;
        _stopPreview();
        this._last = { point: before };
        if (before) this._chain = true;
        return wrapped(event, ...rest);
      }
      _dragging = true;
      _tracing = true;
      _seg = null;
      _runs = [];
      event.interactionData.admTrace = true;
      const origin = event.interactionData.origin ?? canvas.mousePosition;
      const nearEnd = before && Math.hypot(origin.x - before[0], origin.y - before[1]) <= _gridSize() * 0.5;
      const v0 = nearEnd ? before : _snapVertex(origin);
      const corner = _snapVertex({ x: v0[0], y: v0[1] });
      _hold = _same(corner, v0) ? null : corner;   // off-grid start: skip its nearest corner for now
      this._last = { point: v0 };
      _pathAdd(v0);
      _startPreview(this, v0);
    }, "MIXED");
    reg("_onDragLeftMove", function (wrapped, event, ...rest) {
      if (event?.interactionData?.admShiftClick || event?.interactionData?.admRegionClick) return;
      if (!event?.interactionData?.admTrace) return wrapped(event, ...rest);
      try { _traceTo(this, event.interactionData.destination ?? canvas.mousePosition); }
      catch (e) { console.warn("[adm-levels] wall chain: trace", e); }
    }, "MIXED");
    reg("_onDragLeftDrop", function (wrapped, event, ...rest) {
      if (event?.interactionData?.admShiftClick) return;   // the pointer-up listener commits the click
      if (event?.interactionData?.admRegionClick) return;
      if (!event?.interactionData?.admTrace) {
        const r = wrapped(event, ...rest);
        _dragging = false;
        return r;
      }
      _dragging = false;                        // the chain stays open from the last point
      _tracing = false;
      _hold = null;
    }, "MIXED");
    reg("_onDragLeftCancel", function (wrapped, event, ...rest) {
      if (event?.interactionData?.admShiftClick || event?.interactionData?.admRegionClick) return;   // stock cancel would close the chain
      if (!event?.interactionData?.admTrace) {
        const r = wrapped(event, ...rest);      // stock: resets _last → the chain is over
        _dragging = false;
        _stopPreview();
        return r;
      }
      _dragging = false;                        // a cancelled trace keeps what it drew
      _tracing = false;
      _hold = null;
    }, "MIXED");

    // The stock workflow ends every wall with clearPreviewContainer (also after the async
    // create) — resume our pending segment from the chain point once it is done.
    reg("clearPreviewContainer", function (wrapped, ...rest) {
      const r = wrapped(...rest);
      if (_ticker) { try { canvas.app?.ticker?.remove(_ticker); } catch (_e) {} _ticker = null; }
      _preview = null;                          // destroyed by the stock call
      if (isEnabled() && _active(this) && !_dragging && this._last?.point) _startPreview(this, this._last.point);
      return r;
    }, "WRAPPER");

    // Undo (Ctrl+Z) with an OPEN chain: it steps back to the start of the removed wall.
    reg("_onUndoCreate", async function (wrapped, event, ...rest) {
      const open = !!this._last?.point;
      const deleted = await wrapped(event, ...rest);
      try {
        if (open && isEnabled() && _active(this) && Array.isArray(deleted) && deleted.length) {
          const [x0, y0] = deleted[0].c;
          this._last = { point: [x0, y0] };
          _pathTrimTo([x0, y0]);
          if (this.placeables.length <= 0) _cancelChain(this);
          else if (_dragging) _movePreviewStart(this, [x0, y0]);
          else _startPreview(this, [x0, y0]);
        }
      } catch (e) { console.warn("[adm-levels] wall chain: undo", e); }
      return deleted;
    }, "WRAPPER");

    // Undo of a run extension (an "update" entry): the chain tip goes back to the restored end.
    reg("_onUndoUpdate", async function (wrapped, event, ...rest) {
      const tip = this._last?.point ?? null;
      const endsBefore = new Map();
      for (const d of event?.data ?? []) {
        const c = canvas.scene?.walls?.get(d?._id)?.c;
        if (c) endsBefore.set(d._id, [c[2], c[3]]);
      }
      const updated = await wrapped(event, ...rest);
      try {
        if (tip && isEnabled() && _active(this) && Array.isArray(updated)) {
          for (const doc of updated) {
            if (!_same(endsBefore.get(doc?.id), tip)) continue;
            const p = [doc.c[2], doc.c[3]];
            this._last = { point: p };
            _pathTrimTo(p);
            if (_dragging) _movePreviewStart(this, p); else _startPreview(this, p);
            break;
          }
        }
      } catch (e) { console.warn("[adm-levels] wall chain: undo update", e); }
      return updated;
    }, "WRAPPER");

    // Layer switches: keep the interaction state in step with the toggle; drop the chain on leave.
    reg("_activate", function (wrapped, ...rest) {
      const r = wrapped(...rest);
      if (isEnabled() && _on) _applyInteraction(this);
      return r;
    }, "WRAPPER");
    reg("_deactivate", function (wrapped, ...rest) {
      if (_on) { _cancelChain(this); regionForget(); }
      _applyInteraction(this, { restore: true });   // a scene switch redraws the layer: hand the stock value back
      return wrapped(...rest);
    }, "WRAPPER");

    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled() || !game.user?.isGM) return;
      const walls = controls?.walls;
      const tools = walls?.tools;
      if (!tools) return;
      tools.admWallChain = {
        name: "admWallChain",
        order: 100,
        title: game.i18n.localize("ADM_LEVELS.wallChain.button"),
        icon: "fa-solid fa-draw-polygon",
        toggle: true,
        active: _on,
        onChange: (_event, active) => _setMode(!!active),
      };
      // Tool changes inside the walls control (Select ↔ wall types) never re-activate the layer.
      const stock = walls.onToolChange;
      walls.onToolChange = (event, tool) => {
        try { if (stock instanceof Function) stock(event, tool); } finally { _onToolChange(); }
      };
    });

    // A new canvas: the toggle stays, the chain does not.
    Hooks.on("canvasReady", () => {
      _preview = null; _ticker = null; _dragging = false; _tracing = false; _hold = null;
      _seg = null; _runs = []; _pendingClick = null; _path = [];
      regionHide();
      if (_on && !isEnabled()) { _setMode(false); return; }   // sub-module switched off in the settings
      const layer = _layer();
      if (_on && layer?.active) _applyInteraction(layer);
    });
  },
};
