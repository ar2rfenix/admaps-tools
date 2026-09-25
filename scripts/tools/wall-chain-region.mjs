// scripts/tools/wall-chain-region.mjs
// Helper of the «wall chain» sub-module (not a tool of its own): a region from the drawn outline.
//
// When a chain is closed (right click / Esc) and its points enclose an area, a «+ Region» button
// appears next to the first point. Pressing it enters the region pick mode (the walls layer stays
// active): the outline is shown on the canvas and the region under the cursor is highlighted —
// only regions of the floor being viewed, of several the highest one.
//   • click on the highlighted region → the outline is added to it as one more shape (Foundry
//     unions the shapes; an outline that does not touch the region becomes its separate island);
//   • click anywhere else → a new region with the outline, and its window opens;
//   • Esc / right click → back to the button (a second Esc / right click hides it).
// The outline follows the walls in drawing order; where there are no walls (between the last and
// the first point, between separate strokes) the edge is a straight line.
// Ctrl+Z right after the operation reverts it (the new region is deleted, the merged region gets
// its previous shapes back); any further wall change of this user forgets that undo.

const LEVELS_ID = "levels";
const OPT = "admWallChainRegion";   // option marker on our own region writes

let _path = null;       // outline offered by the button: [[x, y], ...]
let _btn = null;        // HTML button
let _mode = false;      // region pick mode
let _gfx = null;        // PIXI graphics: outline + hovered region
let _ticker = null;     // keeps the button on the first point, follows the hover
let _hover = null;      // RegionDocument under the cursor
let _hoverKey = "";
let _placeKey = "";
let _undo = null;       // { kind: "create" | "merge", id, shapes? }
let _inited = false;

const _same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const _t = (key) => game.i18n.localize(key);

/* -------------------------------------------- */
/*  Outline                                     */
/* -------------------------------------------- */

/** Consecutive duplicates and the closing duplicate removed. */
function _cleanPath(path) {
  const out = [];
  for (const p of path ?? []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (!_same(out[out.length - 1], p)) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && _same(out[0], out[out.length - 1])) out.pop();
  return out;
}

function _area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/* -------------------------------------------- */
/*  Floors                                      */
/* -------------------------------------------- */

/** The floor this client is looking at: {bottom, top} or null (= every region counts).
 *  Same rule as the effect-floors tool: the controlled token's floor, else the Levels panel. */
function _viewerSpan() {
  try {
    const levels = canvas?.scene?.getFlag?.(LEVELS_ID, "sceneLevels");
    const tok = canvas?.tokens?.controlled?.[0] ?? CONFIG.Levels?.currentToken ?? null;
    if (tok) {
      const z = Number(tok.document?.elevation);
      if (!Array.isArray(levels) || !levels.length || !Number.isFinite(z)) return null;
      for (const l of levels) {
        const b = parseFloat(l?.[0]), t = parseFloat(l?.[1]);
        if (Number.isFinite(b) && Number.isFinite(t) && z >= b && z < t) return { bottom: b, top: t };
      }
      return null;
    }
    const ui = CONFIG.Levels?.UI;
    if (ui?.rangeEnabled && Array.isArray(ui.range)) {
      const b = parseFloat(ui.range[0]), t = parseFloat(ui.range[1]);
      if (Number.isFinite(b) && Number.isFinite(t)) return { bottom: b, top: t };
    }
  } catch (_e) {}
  return null;
}

/** Regions of the viewed floor, the highest first. A null bound is open (−∞ / +∞). */
function _candidates() {
  const span = _viewerSpan();
  const out = [];
  for (const doc of canvas.scene?.regions ?? []) {
    const eb = doc.elevation?.bottom, et = doc.elevation?.top;
    const b = (eb === null || eb === undefined) ? -Infinity : Number(eb);
    const t = (et === null || et === undefined) ? Infinity : Number(et);
    if (span && !(b < span.top && t >= span.bottom)) continue;
    out.push({ doc, b, t });
  }
  const desc = (x, y) => (x === y ? 0 : (x < y ? 1 : -1));
  out.sort((p, q) => desc(p.b, q.b) || desc(p.t, q.t));
  return out;
}

/* -------------------------------------------- */
/*  Button                                      */
/* -------------------------------------------- */

function _buttonText() {
  if (!_btn) return;
  const icon = _mode ? "fa-solid fa-hand-pointer" : "fa-solid fa-plus";
  const text = _t(_mode ? "ADM_LEVELS.wallChain.regionPick" : "ADM_LEVELS.wallChain.regionButton");
  _btn.innerHTML = `<i class="${icon}"></i> ${foundry.utils.escapeHTML(text)}`;
  _btn.dataset.tooltip = _t(_mode ? "ADM_LEVELS.wallChain.regionCancelHint" : "ADM_LEVELS.wallChain.regionButtonHint");
}

function _showButton() {
  if (!_btn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "adm-wall-chain-region";
    b.style.cssText = [
      "position:fixed", "z-index:var(--z-index-app, 30)", "width:auto", "min-width:0", "height:auto",
      "flex:none", "margin:0", "padding:3px 9px", "font-size:12px", "line-height:18px",
      "white-space:nowrap", "border-radius:5px", "cursor:pointer", "pointer-events:auto",
      "transform:translate(-50%, calc(-100% - 12px))",
      "background:rgba(20, 22, 28, 0.92)", "color:#f0f0e0", "border:1px solid #ff9a3c",
      "box-shadow:0 1px 4px rgba(0,0,0,0.6)",
    ].join(";");
    // The page under the button is the canvas — keep the press to ourselves.
    b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      b.blur();                                   // keys must keep going to the canvas (Esc, Ctrl+Z)
      if (_mode) regionCancel(); else _enterMode();
    });
    document.body.appendChild(b);
    _btn = b;
  }
  _buttonText();
  _placeKey = "";
  _place();
  if (!_ticker && canvas?.app?.ticker) {
    _ticker = () => { try { _tick(); } catch (e) { console.warn("[adm-levels] wall chain region: tick", e); } };
    canvas.app.ticker.add(_ticker);
  }
}

function _place() {
  if (!_btn || !_path?.length || !canvas?.ready) return;
  const c = canvas.clientCoordinatesFromCanvas({ x: _path[0][0], y: _path[0][1] });
  const key = `${Math.round(c.x)},${Math.round(c.y)}`;
  if (key === _placeKey) return;
  _placeKey = key;
  _btn.style.left = `${Math.round(c.x)}px`;
  _btn.style.top = `${Math.round(c.y)}px`;
}

function _tick() {
  if (!_path) return;
  _place();
  if (_mode) _updateHover(false);
}

function _stopTicker() {
  if (_ticker) { try { canvas.app?.ticker?.remove(_ticker); } catch (_e) {} _ticker = null; }
}

/* -------------------------------------------- */
/*  Pick mode                                   */
/* -------------------------------------------- */

function _enterMode() {
  if (!_path || !canvas?.walls?.active) { regionHide(); return; }
  _mode = true;
  _hover = null;
  _hoverKey = "";
  try {
    _gfx = new PIXI.Graphics();
    _gfx.eventMode = "none";
    canvas.interface.addChild(_gfx);
  } catch (e) { console.warn("[adm-levels] wall chain region: overlay", e); _gfx = null; }
  _buttonText();
  _updateHover(true);
}

function _endMode() {
  _mode = false;
  _hover = null;
  _hoverKey = "";
  if (_gfx) { try { if (!_gfx.destroyed) _gfx.destroy(); } catch (_e) {} _gfx = null; }
}

function _updateHover(force) {
  const m = canvas.mousePosition;
  if (!m) return;
  const scale = canvas.stage?.scale?.x || 1;
  const key = `${Math.round(m.x)},${Math.round(m.y)},${scale.toFixed(3)}`;
  if (!force && key === _hoverKey) return;
  _hoverKey = key;
  let hit = null;
  for (const c of _candidates()) {
    try { if (c.doc.polygonTree?.testPoint({ x: m.x, y: m.y })) { hit = c.doc; break; } } catch (_e) {}
  }
  if (hit === _hover && !force && _gfx?.__admScale === scale) return;
  _hover = hit;
  _draw(scale);
}

function _draw(scale) {
  const g = _gfx;
  if (!g || g.destroyed || !_path) return;
  g.clear();
  const w = 1 / scale;
  if (_hover) {
    let col = 0xffffff;
    try { col = Number(foundry.utils.Color.from(_hover.color)); } catch (_e) {}
    g.lineStyle(3 * w, col, 0.95);
    g.beginFill(col, 0.3);
    for (const node of _hover.polygonTree ?? []) if (!node.isHole) g.drawPolygon(node.polygon.points);
    g.endFill();
    g.lineStyle(2 * w, col, 0.8);
    for (const node of _hover.polygonTree ?? []) if (node.isHole) g.drawPolygon(node.polygon.points);
  }
  g.lineStyle(2 * w, 0xffffff, 0.95);
  g.beginFill(0xffffff, _hover ? 0.15 : 0.25);
  g.drawPolygon(_path.flat());
  g.endFill();
  g.__admScale = scale;
}

/** Levels (with its stairs on and our stair gate off) hangs a stair script on ANY new region. */
async function _stripLevelsStair(region) {
  const pass = async () => {
    try {
      const bad = (region.behaviors ?? []).filter((b) =>
        b?.type === "executeScript" && String(b.system?.source ?? "").includes("RegionHandler"));
      if (bad.length) await region.deleteEmbeddedDocuments("RegionBehavior", bad.map((b) => b.id));
    } catch (e) { console.warn("[adm-levels] wall chain region: Levels cleanup", e); }
  };
  await pass();
  await new Promise((r) => setTimeout(r, 250));   // their behavior arrives deferred
  if (canvas.scene?.regions?.get(region.id)) await pass();
}

async function _apply(pts, target) {
  const shape = { type: "polygon", points: pts.flat(), hole: false };
  try {
    if (target) {
      const prev = target.toObject().shapes;
      await target.update({ shapes: [...prev, shape] }, { [OPT]: true });
      _undo = { kind: "merge", id: target.id, shapes: prev };
      ui.notifications?.info(game.i18n.format("ADM_LEVELS.wallChain.regionMerged", { name: target.name }));
      return;
    }
    const cls = CONFIG.Region.documentClass;
    let name = "";
    try { name = cls.defaultName?.({ parent: canvas.scene }) ?? ""; } catch (_e) {}
    if (!String(name).trim()) name = _t("DOCUMENT.Region");
    const created = await canvas.scene.createEmbeddedDocuments("Region", [{ name, shapes: [shape] }], { [OPT]: true });
    const doc = created?.[0];
    if (!doc) return;
    _undo = { kind: "create", id: doc.id };
    void _stripLevelsStair(doc);
    doc.sheet?.render(true);
  } catch (e) {
    console.warn("[adm-levels] wall chain region: apply", e);
    ui.notifications?.error(_t("ADM_LEVELS.wallChain.regionFailed"));
  }
}

/* -------------------------------------------- */
/*  API for the wall chain tool                 */
/* -------------------------------------------- */

/** A chain was closed by the user: offer the button if the outline encloses an area. */
export function regionOffer(path) {
  regionHide();
  const pts = _cleanPath(path);
  if (pts.length < 3 || Math.abs(_area(pts)) < 1) return;
  _path = pts;
  _showButton();
}

/** Drop the button and the pick mode. */
export function regionHide() {
  _endMode();
  _path = null;
  _stopTicker();
  if (_btn) { try { _btn.remove(); } catch (_e) {} _btn = null; }
}

/** Esc / right click in the pick mode: back to the button. */
export function regionCancel() {
  if (!_mode) return;
  _endMode();
  _buttonText();
}

export const regionModeActive = () => _mode;
export const regionOffered = () => !!_path;

/** Click on the canvas in the pick mode → merge into the hovered region or create a new one. */
export function regionClick() {
  if (!_mode || !_path) return false;
  _updateHover(true);
  const pts = _path;
  const target = _hover;
  regionHide();
  void _apply(pts, target);
  return true;
}

/** Ctrl+Z right after an operation: revert it. false → nothing to revert (let the stock undo run). */
export function regionUndo() {
  const u = _undo;
  _undo = null;
  if (!u) return false;
  const doc = canvas.scene?.regions?.get(u.id);
  if (!doc) return false;
  (async () => {
    try {
      if (u.kind === "create") {
        await doc.delete({ [OPT]: true });
        ui.notifications?.info(_t("ADM_LEVELS.wallChain.regionUndoCreate"));
      } else {
        await doc.update({ shapes: u.shapes }, { [OPT]: true });
        ui.notifications?.info(game.i18n.format("ADM_LEVELS.wallChain.regionUndoMerge", { name: doc.name }));
      }
    } catch (e) { console.warn("[adm-levels] wall chain region: undo", e); }
  })();
  return true;
}

export function regionForget() { _undo = null; }

/** Hooks that keep the button and the undo slot honest. Call once. */
export function regionInit() {
  if (_inited) return;
  _inited = true;
  const mine = (userId) => userId === game.user?.id;
  Hooks.on("createWall", (_doc, _options, userId) => { if (mine(userId)) _undo = null; });
  Hooks.on("updateWall", (_doc, _changes, _options, userId) => { if (mine(userId)) _undo = null; });
  Hooks.on("deleteWall", (_doc, _options, userId) => {
    if (!mine(userId)) return;
    _undo = null;
    if (_path) regionHide();                       // the offered outline no longer matches the walls
  });
  Hooks.on("updateRegion", (doc, changes, options) => {
    if (options?.[OPT] || _undo?.id !== doc.id) return;
    if (_undo.kind === "merge" && "shapes" in (changes ?? {})) _undo = null;   // someone reshaped it
  });
  Hooks.on("deleteRegion", (doc) => { if (_undo?.id === doc.id) _undo = null; });
  Hooks.on("canvasTearDown", () => { regionHide(); _undo = null; });
}
