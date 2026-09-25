// modules/adm-levels/scripts/tools/door-swing-preview.mjs
// ADMaps Tools — «Door swing preview».
// A thin arc with an arrow and a hinge dot over a door: which way and from which side it opens.
// Shown in two cases:
//   • a door wall's config window is open — only for that door, values taken from the LIVE form,
//     so the picture updates immediately when «Direction» / «Double» / «Strength» change;
//   • Alt+W is pressed (map scaffolding, hook `admLevelsWallsToggled`) — for ALL doors on the
//     scene, values from the documents.
//
// ⚠️ The geometry MIRRORS the core one (client/canvas/containers/elements/door-mesh.mjs), otherwise
// the preview would lie:
//   • SINGLE style  → hinge at A, width = wall length, base angle = wall angle;
//   • DOUBLE_LEFT   → hinge at A, width = half, wall angle;
//   • DOUBLE_RIGHT  → hinge at B, width = half, wall angle − π, direction INVERTED;
//   • for types with midpoint (ascend/descend/swivel) the hinge is not at the end but at 0.5 / 0.25 / 0.75;
//   • swing/swivel  → rotation by π·direction·strength/2;
//   • slide         → shift by (A − B)·direction·m, where m = strength (single) or strength/2;
//     ⚠️ the shift direction is computed from the WALL angle: the right leaf's base angle is turned
//     by π, and the sign derived from it would come out reversed.
// The core does not animate a door without `animation.type` (see Wall#hasDoorMesh) — we skip it.

import { panelFloor, wallOnFloor } from "./floor-range.mjs";

let _isEnabled = () => true;        // tool checkbox — checked on redraw as well
let _altAll = false;                // map scaffolding display is on (Alt+W)

// Red: in the Alt+W overlay walls and doors come in blue/orange/lilac, and the arc blended in
// with them. Secret door — the same red, but darker.
const COL = {
  door: 0xff2d2d,
  secret: 0xc21f1f,
  hinge: 0xffffff,    // hinge
};

let _layerC = null;                 // shared container on the interface layer
const _apps = new Map();            // app → { onChange }

const _gs = () => Number(canvas?.grid?.size) || 100;

/** Thicknesses and sizes: thin, but not vanishing on a large grid. */
function _style() {
  const gs = _gs();
  return {
    line: Math.max(1.5, gs * 0.022),
    thin: Math.max(1, gs * 0.014),
    tip: Math.max(6, gs * 0.11),
    hinge: Math.max(2.5, gs * 0.042),
  };
}

function _layer() {
  if (!canvas?.ready) return null;
  if (_layerC && !_layerC.destroyed) return _layerC;
  const host = canvas.interface ?? canvas.controls ?? canvas.stage;
  if (!host) return null;
  const c = new PIXI.Container();
  c.eventMode = "none";
  host.addChild(c);
  _layerC = c;
  return c;
}

function _dropLayer() {
  try { _layerC?.parent?.removeChild(_layerC); } catch { /* ignore */ }
  try { _layerC?.destroy({ children: true }); } catch { /* ignore */ }
  _layerC = null;
}

/* ------------------------------------------------------------------ */
/*  Animation settings: from the form (window open) or from the document */
/* ------------------------------------------------------------------ */

function _cfgOf(a) {
  const type = String(a?.type ?? "");
  if (!type) return null;                                   // the core does not animate such a door
  const dir = Number(a?.direction ?? 1);
  const str = Number(a?.strength ?? 1);
  return {
    type,
    direction: dir < 0 ? -1 : 1,
    double: !!a?.double,
    strength: Math.min(2, Math.max(0.05, Number.isFinite(str) ? str : 1)),
  };
}

function _cfgFromForm(app) {
  const el = app?.element;
  if (!el) return null;
  const q = (n) => el.querySelector(`[name="${n}"]`);
  const num = (n, d) => { const v = Number(q(n)?.value); return Number.isFinite(v) ? v : d; };
  const doorEl = q("door");
  const door = doorEl ? num("door", 0) : Number(app.document?.door ?? 0);
  if (!door) return null;                                   // not a door — nothing to show
  const a = app.document?.animation ?? {};
  const typeEl = q("animation.type");
  const dblEl = q("animation.double");
  return _cfgOf({
    type: typeEl ? typeEl.value : a.type,
    direction: q("animation.direction") ? num("animation.direction", 1) : a.direction,
    double: dblEl ? dblEl.checked : a.double,
    strength: q("animation.strength") ? num("animation.strength", 1) : a.strength,
  });
}

/** Door leaves: hinge, base angle, length and direction — as DoorMesh computes them. */
function _leaves(doc, cfg) {
  const c = doc?.c;
  if (!Array.isArray(c) || c.length < 4 || !c.every(Number.isFinite)) return [];
  const [x1, y1, x2, y2] = c;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1) return [];
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const mid = CONFIG.Wall?.animationTypes?.[cfg.type]?.midpoint === true;
  const at = (t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  if (!cfg.double) {
    return [{ pivot: mid ? at(0.5) : { x: x1, y: y1 }, base: angle, wall: angle, len, dir: cfg.direction }];
  }
  return [
    { pivot: mid ? at(0.25) : { x: x1, y: y1 }, base: angle, wall: angle, len: len / 2, dir: cfg.direction },
    { pivot: mid ? at(0.75) : { x: x2, y: y2 }, base: angle - Math.PI, wall: angle, len: len / 2, dir: -cfg.direction },
  ];
}

/* ------------------------------------------------------------------ */
/*  Drawing                                                            */
/* ------------------------------------------------------------------ */

function _arrow(g, x, y, angle, size, color, alpha) {
  const back = angle + Math.PI;
  const w = size * 0.38;
  const bx = x + Math.cos(back) * size, by = y + Math.sin(back) * size;
  g.lineStyle(0);
  g.beginFill(color, alpha);
  g.drawPolygon([
    x, y,
    bx + Math.cos(back + Math.PI / 2) * w, by + Math.sin(back + Math.PI / 2) * w,
    bx + Math.cos(back - Math.PI / 2) * w, by + Math.sin(back - Math.PI / 2) * w,
  ]);
  g.endFill();
}

function _chevrons(g, x, y, up, size, color, alpha, w) {
  g.lineStyle(w, color, alpha);
  for (let i = 0; i < 2; i++) {
    const oy = (i * size * 0.5) - size * 0.25;
    const dy = up ? -1 : 1;
    g.moveTo(x - size * 0.4, y + oy - dy * size * 0.22);
    g.lineTo(x, y + oy);
    g.lineTo(x + size * 0.4, y + oy - dy * size * 0.22);
  }
}

function _drawLeaf(g, leaf, cfg, color, focus) {
  const st = _style();
  const alpha = focus ? 0.95 : 0.7;
  const { pivot, base, wall, len, dir } = leaf;
  const R = Math.max(len, 1);
  const closed = { x: pivot.x + Math.cos(base) * R, y: pivot.y + Math.sin(base) * R };

  if (cfg.type === "slide") {
    // Core shift: (A − B)·dir·m. The A−B vector points along the wall angle + π.
    const m = cfg.double ? cfg.strength * 0.5 : cfg.strength;
    const shift = R * m * (cfg.double ? 2 : 1);              // for a double door len is already halved
    const ang = dir > 0 ? wall + Math.PI : wall;
    const mx = (pivot.x + closed.x) / 2, my = (pivot.y + closed.y) / 2;
    const ex = mx + Math.cos(ang) * shift, ey = my + Math.sin(ang) * shift;
    g.lineStyle(st.line, color, alpha);
    g.moveTo(mx, my); g.lineTo(ex, ey);
    _arrow(g, ex, ey, ang, st.tip, color, alpha);
    return;
  }

  if (cfg.type === "ascend" || cfg.type === "descend") {
    const mx = (pivot.x + closed.x) / 2, my = (pivot.y + closed.y) / 2;
    _chevrons(g, mx, my, cfg.type === "ascend", Math.max(12, _gs() * 0.3), color, alpha, st.line);
    return;
  }

  // swing / swivel and anything unknown (the core falls back to swing too).
  const delta = Math.PI * dir * cfg.strength / 2;
  const ccw = delta < 0;
  const end = base + delta;
  const openEnd = { x: pivot.x + Math.cos(end) * R, y: pivot.y + Math.sin(end) * R };

  // The leaf in its open position — a thin ray from the hinge.
  g.lineStyle(st.thin, color, alpha * 0.5);
  g.moveTo(pivot.x, pivot.y); g.lineTo(openEnd.x, openEnd.y);

  // Travel arc: from the edge of the closed leaf to the open one.
  g.lineStyle(st.line, color, alpha);
  g.moveTo(closed.x, closed.y);                              // start from the edge, not from the hinge
  g.arc(pivot.x, pivot.y, R, base, end, ccw);

  // Arrowhead along the tangent — where the leaf edge is heading.
  _arrow(g, openEnd.x, openEnd.y, end + (dir > 0 ? Math.PI / 2 : -Math.PI / 2), st.tip, color, alpha);
}

function _drawDoor(g, doc, cfg, focus) {
  const color = Number(doc.door) === 2 ? COL.secret : COL.door;
  const leaves = _leaves(doc, cfg);
  if (!leaves.length) return;
  for (const leaf of leaves) _drawLeaf(g, leaf, cfg, color, focus);
  const st = _style();
  for (const leaf of leaves) {                               // hinges — on top of the arcs
    g.lineStyle(st.thin, 0x000000, 0.6);
    g.beginFill(COL.hinge, focus ? 0.95 : 0.75);
    g.drawCircle(leaf.pivot.x, leaf.pivot.y, st.hinge);
    g.endFill();
  }
}

function _redraw() {
  if (!_isEnabled()) { _dropLayer(); return; }               // checkbox was unticked mid-way
  const c = _layer();
  if (!c) return;
  c.removeChildren().forEach((ch) => { try { ch.destroy(); } catch { /* ignore */ } });

  const drawn = new Set();
  const g = new PIXI.Graphics();
  g.eventMode = "none";

  // 1) Doors from open config windows — from the live form, brighter.
  for (const app of _apps.keys()) {
    const cfg = _cfgFromForm(app);
    if (!cfg) continue;
    const docs = app.editTargets?.size ? [...app.editTargets] : [app.document];
    for (const doc of docs) {
      if (!doc?.id || doc.parent?.id !== canvas.scene?.id) continue;
      if (!Number(doc.door)) continue;                       // in a batch of walls not every one is a door
      drawn.add(doc.id);
      _drawDoor(g, doc, cfg, true);
    }
  }

  // 2) Alt+W — all the other doors on the scene, from their documents. With a floor picked in the
  //    Levels panel — only that floor's doors, like the rest of the Alt+W markup (main.mjs).
  if (_altAll) {
    const floor = panelFloor();
    for (const doc of (canvas.scene?.walls ?? [])) {
      if (!Number(doc.door) || drawn.has(doc.id)) continue;
      if (!wallOnFloor(doc, floor)) continue;
      const cfg = _cfgOf(doc.animation);
      if (!cfg) continue;                                    // no animation — no swing either
      _drawDoor(g, doc, cfg, false);
    }
  }

  c.addChild(g);
}

const _redrawSoon = foundry.utils.debounce(() => {
  try { _redraw(); } catch (e) { console.warn("[ADM:LEVELS] door swing preview: redraw failed", e); }
}, 30);

/* ------------------------------------------------------------------ */
/*  Hooking into the wall config window                                */
/* ------------------------------------------------------------------ */

function _attach(app, element) {
  const el = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
  if (!el) return;
  if (!_apps.has(app)) _apps.set(app, { onChange: () => _redrawSoon() });
  const { onChange } = _apps.get(app);
  // The form is rebuilt when the animation type changes — the marker lives with the element, so
  // listeners are attached afresh to the new DOM and are not attached twice to the old one.
  if (!el.dataset.admDoorPreview) {
    el.dataset.admDoorPreview = "1";
    el.addEventListener("change", onChange);
    el.addEventListener("input", onChange);
  }
  _redraw();
}

function _detach(app) {
  _apps.delete(app);
  if (!_apps.size && !_altAll) { _dropLayer(); return; }
  _redraw();
}

export const TOOL = {
  id: "doorSwingPreview",
  name: "ADM_LEVELS.settings.doorSwingPreview.name",
  hint: "ADM_LEVELS.settings.doorSwingPreview.hint",
  settingScope: "client",

  onReady({ isEnabled }) {
    _isEnabled = isEnabled;

    Hooks.on("renderWallConfig", (app, element) => {
      if (!isEnabled()) return;
      try { _attach(app, element); } catch (e) { console.warn("[ADM:LEVELS] door swing preview: attach failed", e); }
    });
    Hooks.on("closeWallConfig", (app) => { try { _detach(app); } catch { /* ignore */ } });

    // Alt+W («show map scaffolding») — the same arc for every door on the scene.
    Hooks.on("admLevelsWallsToggled", (visible) => {
      _altAll = !!visible;
      if (!_altAll && !_apps.size) { _dropLayer(); return; }
      _redrawSoon();
      // The Levels floor panel opens on this same signal and gets its floor a moment later.
      if (_altAll) { setTimeout(_redrawSoon, 400); setTimeout(_redrawSoon, 1200); }
    });
    // Another floor picked in the Levels panel, or the panel closed (floor dropped).
    Hooks.on("levelsUiChangeLevel", () => { if (_altAll) _redrawSoon(); });
    Hooks.on("closeLevelsUI", () => { if (_altAll) setTimeout(_redrawSoon, 0); });

    // A scene change takes the layer away with the canvas; Alt+W resets itself there.
    Hooks.on("canvasReady", () => { _layerC = null; _altAll = false; if (_apps.size) _redrawSoon(); });

    // The wall was moved, flipped or had its animation changed while the preview is on screen.
    for (const h of ["createWall", "updateWall", "deleteWall"]) {
      Hooks.on(h, (doc) => {
        if (!_apps.size && !_altAll) return;
        if (doc?.parent?.id !== canvas?.scene?.id) return;
        _redrawSoon();
      });
    }
  },
};
