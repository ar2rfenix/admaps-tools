// scripts/tools/tile-partial-fade.mjs
// ADMaps Tools sub-module: «Partial fade» — one more entry in the tile config occlusion list.
//
// WHAT. Hovered, such a roof dissolves only at the doors and windows under it: in front of each one (so the
// player sees where it is — closed doors too) and wherever the token looks through an open door or a window:
// a cut-out into the room. Along blind walls it stays — the strip of roof in front of a wall used to dissolve
// down to the wall line and bare the dark wall art (23.09.2026: «under the walls nearest to me the tile must
// not dissolve, it has to cover the cut of the view»; then «at the door and windows cut as before»; then
// «door closed — dissolve the tile up to the door, so the player sees where it is»). Nothing shows behind a
// closed door (core's LOS stops there), doors work as before. A closed SECRET door is a wall to the players
// and stays covered. A token standing under the roof fades it whole, exactly like «Fade».
// A window is any wall with sight «Proximity» (PROXIMITY; core's «Window» tool makes those), whatever its
// threshold in feet — the user: «any values in feet, what matters is Proximity». Invisible walls (sight NONE)
// are railings and props: counting them would bare the strip in front of the wall again.
//
// STORAGE. Core FADE + flags.adm-levels.partialFade: core validates occlusion.mode against its own list, a new
// number would not save. The extra <option> submits FADE as well; a hidden checkbox tells the two apart.
//
// HOW. Core already fades a hovered roof per pixel through the occlusion mask's blue channel while an occluding
// token has vision (canvas/primary/primary-occludable-object.mjs #updateOcclusionState; layers/masks/
// occlusion.mjs _updateOcclusionMask draws every token's LOS there with its elevation index, MIN blending,
// 1 = not occluded). Right after core draws the mask we:
//   1) raise blue to 1 over the roof's opaque pixels (MAX_COLOR, alpha of the tile texture);
//   2) put the token's value back over LOS ∩ (front strip ∪ view) of each door and window under the roof
//      (MIN_ALL).
// The front strip is the opening pushed one grid cell toward the eye, exactly its length. The view is what lies
// PAST the opening between the rays from the eye through its ends — exactly the points whose sight line crosses
// it. ⚠️ Not the whole cone from the eye: in front of the door it slid past the door's end whenever the eye was
// off-centre, and bared the roof over the wall next to the door (23.09.2026: «something near the door opened
// up»). How far the view goes past a window is core's business (its threshold shapes the LOS).
// Red (whole-tile fade: a token under the roof) and green (radial) channels stay untouched.
//
// EDGE OF THE CUT (two own checkboxes, 23.09.2026: «a black outline on the cut — sometimes it is unclear what is
// roof and what is inside»; «try an inner shadow right away, for some feeling of volume»). Drawn just above the
// roof (a PrimaryGraphics at the roof's elevation, next sort), only along stretches where the roof goes on past
// the edge — the cut's sides out on the open deck get nothing:
//   • outline — a black line along those stretches;
//   • inner shadow — nested bands around them (Clipper offset), cut to the inside of the cut: a soft dark
//     gradient falling from the roof edge into the room.
//   • fog (23.09.2026: «on hover show the fog black behind the wall under the roof — now the roof is drawn
//     there; or will that spoil the roof behind ordinary walls?») — inside the cut, what the token does not
//     see (the shadow of a mast, a column, a crate) is black like the fog, not roof. Only within the convex
//     outline of what IS seen through the opening, and only past the opening: the roof beyond the room's own
//     walls stays roof. (A room with an inward corner gets the notch behind that corner black as well.)
//     A checkbox of the TILE, under «Partial fade» (23.09.2026: «per tile, not global — sometimes it is useful,
//     sometimes utter nonsense»); the outline and the shadow stay module settings.
// All three only PAST the openings, the opening's own line excluded: at the door itself they framed and
// darkened the door (23.09.2026: «no frame and shadow where the door or window is — it looks bad and covers
// the door»). A closed door shows its front strip and nothing else.
// Shows as much as the roof is hover-faded; hidden when the roof fades whole (a token under it, no vision).
// The geometry is built lazily, on the first hovered frame after the mask changed: moving tokens redraw the
// mask every frame, and nobody needs the edge until the roof is hovered.
// Diagnostics from the console: __admPartialFade.diag().

import { addTileFade } from "./tile-fade-extra.mjs";

const MODULE_ID = "adm-levels";
const FLAG = "partialFade";        // flags.adm-levels.partialFade (boolean)
const S_OUTLINE = "tilePartialFadeOutline"; // world setting: black outline along the cut
const S_SHADOW = "tilePartialFadeShadow";   // world setting: inner shadow along the cut
const FLAG_FOG = "partialFadeFog";          // flags.adm-levels.partialFadeFog: PER TILE — unseen inside the cut is black
const S_HIDE = "tilePartialFadeHideOnRoof"; // world setting: tokens on the roof inside the cut fade out while hovered
const ALPHA = 0.5;                 // roof silhouette: texture alpha threshold
const SIDE_PX = 8;                 // a door or window is «under the roof» if the roof covers its midpoint or a point this far to a side
const EDGE_STEP = 3;               // px: how often the edge asks «is the roof here?» along the cut
const SHADOW_BANDS = 8;            // inner shadow: nested bands (more = smoother gradient)
const SHADOW_BAND_ALPHA = 0.08;    // alpha of one band; next to the edge all bands add up to ≈0.49
const SF = CONST.CLIPPER_SCALING_FACTOR ?? 100;

/** Is this tile set to «Partial fade»? Only together with core FADE (the entry it rides on). */
function _isPartial(doc) {
  return !!doc?.flags?.[MODULE_ID]?.[FLAG] && (doc?.occlusion?.mode === CONST.OCCLUSION_MODES.FADE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Occlusion mask
// ─────────────────────────────────────────────────────────────────────────────

let _Shader = null;
/** Sampler shader: blue = 1 where the texture is opaque, black elsewhere (a no-op under MAX_COLOR). */
function _silhouetteShader() {
  if (_Shader) return _Shader;
  _Shader = class AdmPartialFadeSilhouetteShader extends foundry.canvas.rendering.shaders.BaseSamplerShader {
    static classPluginName = null;
    static fragmentShader = `
      precision ${PIXI.settings.PRECISION_FRAGMENT} float;
      uniform sampler2D sampler;
      varying vec2 vUvs;
      void main() {
        gl_FragColor = vec4(0.0, 0.0, step(${ALPHA.toFixed(2)}, texture2D(sampler, vUvs).a), 1.0);
      }`;
  };
  return _Shader;
}

/** Our two layers inside the occlusion mask, drawn after core's token graphics. */
function _layers(mask) {
  const cur = mask.__admPartialFade;
  if (cur && !cur.roofs.destroyed && cur.roofs.parent === mask) return cur;
  const roofs = new PIXI.Container();
  const cuts = new PIXI.LegacyGraphics();
  cuts.blendMode = PIXI.BLEND_MODES.MIN_ALL;
  mask.addChild(roofs, cuts);
  return (mask.__admPartialFade = { roofs, cuts, sprites: new Map() });
}

/** The roof silhouette sprite, kept on the tile mesh's texture and canvas transform. */
function _syncSprite(L, tile) {
  const mesh = tile.mesh;
  let s = L.sprites.get(tile.id);
  if (!s || s.destroyed) {
    s = new foundry.canvas.containers.SpriteMesh(mesh.texture, _silhouetteShader());
    s.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
    L.roofs.addChild(s);
    L.sprites.set(tile.id, s);
  }
  if (s.texture !== mesh.texture) s.texture = mesh.texture;
  s.anchor.copyFrom(mesh.anchor);
  s.transform.setFromMatrix(mesh.canvasTransform);
}

function _bound(raw, inf) {
  if (raw === null || raw === undefined || raw === "") return inf; // wall-height keeps an empty bound as null
  const n = Number(raw);
  return Number.isFinite(n) ? n : inf;
}

/** Does the wall stand at this eye height (wall-height span; no span = endless)? A door of another floor
 *  is not this token's business: cutting the roof at it would open a hole for nothing. */
function _atEye(doc, eye) {
  const f = doc?.flags?.["wall-height"] ?? {};
  return _bound(f.bottom, -Infinity) <= eye && eye <= _bound(f.top, Infinity);
}

/** A door (open or closed; a closed secret door is a wall to the players) or a window — sight «Proximity»,
 *  any threshold (see the header). */
function _isDoorOrWindow(doc) {
  const S = CONST.WALL_SENSE_TYPES;
  if (doc.sight === S.NONE) return false;
  if (doc.door > CONST.WALL_DOOR_TYPES.NONE) {
    return (doc.door !== CONST.WALL_DOOR_TYPES.SECRET) || (doc.ds === CONST.WALL_DOOR_STATES.OPEN);
  }
  return doc.sight === S.PROXIMITY;
}

/** Does the roof cover the door (its midpoint, or a point a little to either side — doors sit on the roof edge)? */
function _underRoof(mesh, c) {
  const [x0, y0, x1, y1] = c;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / len) * SIDE_PX, ny = ((x1 - x0) / len) * SIDE_PX;
  for (const p of [{ x: mx, y: my }, { x: mx + nx, y: my + ny }, { x: mx - nx, y: my - ny }]) {
    if (mesh.containsCanvasPoint(p, ALPHA)) return true;
  }
  return false;
}

/** The view PAST a door or window: the segment and the rays from the eye through its ends — exactly the
 *  points whose sight line crosses the opening. */
function _behind(o, c) {
  const ax = c[0] - o.x, ay = c[1] - o.y, bx = c[2] - o.x, by = c[3] - o.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1 || lb < 1) return null;                              // the eye sits on a door end
  if (Math.abs(ax * by - ay * bx) < 1e-3 * la * lb) return null;  // the door is seen edge-on
  const far = (canvas.dimensions?.maxR ?? 1e5) * 2;
  return new PIXI.Polygon([
    c[0], c[1], c[2], c[3],
    c[2] + (bx / lb) * far, c[3] + (by / lb) * far,
    c[0] + (ax / la) * far, c[1] + (ay / la) * far,
  ]);
}

/** Convex hull of Clipper paths (monotone chain), as one Clipper path. */
function _hull(paths) {
  const pts = [];
  for (const p of paths) for (const q of p) pts.push(q);
  if (pts.length < 3) return null;
  pts.sort((a, b) => (a.X - b.X) || (a.Y - b.Y));
  const cross = (o, a, b) => ((a.X - o.X) * (b.Y - o.Y)) - ((a.Y - o.Y) * (b.X - o.X));
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : null;
}

/** The strip in front of a door or window, its whole length, one grid cell deep toward the eye — the cone
 *  narrows there when the token stands close (23.09.2026: the user marked this strip «up to the door»). */
function _front(o, c) {
  const dx = c[2] - c[0], dy = c[3] - c[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  let nx = -dy / len, ny = dx / len;
  if (((o.x - c[0]) * nx) + ((o.y - c[1]) * ny) < 0) { nx = -nx; ny = -ny; } // the side the eye is on
  const depth = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
  return new PIXI.Polygon([
    c[0], c[1], c[2], c[3],
    c[2] + (nx * depth), c[3] + (ny * depth),
    c[0] + (nx * depth), c[1] + (ny * depth),
  ]);
}

/** Draw LOS ∩ polygon with the token's value; the drawn Clipper paths go to `out` (for the outline).
 *  Clipper keeps every piece: the view may come out split. */
function _cut(g, los, poly, value, out) {
  if (!poly) return;
  const paths = los.intersectClipper(poly.toClipperPoints({ scalingFactor: SF }), { scalingFactor: SF });
  for (const path of paths) {
    if (path.length < 3) continue;
    g.beginFill(0xFFFF00 | value).drawShape(PIXI.Polygon.fromClipperPoints(path, { scalingFactor: SF })).endFill();
    out.push(path);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge of the cut: outline + inner shadow
// ─────────────────────────────────────────────────────────────────────────────

/** tileId → { g: PrimaryGraphics right above the roof, pieces: the cut's Clipper paths, dirty, stats }. */
const _edges = new Map();
let _lastError = null;

function _setting(key) {
  try { return !!game.settings.get(MODULE_ID, key); } catch (_e) { return false; }
}

function _dropEdge(id) {
  const e = _edges.get(id);
  _edges.delete(id);
  try { if (e?.g && !e.g.destroyed) e.g.destroy(); } catch (_e) {}
}

/** The ticker the edge updater is attached to. ⚠️ Attached here, not in onReady: the tool registry starts
 *  tools on SETUP (main.mjs startTools), before the canvas exists — `canvas.app?.ticker?.add` there silently
 *  did nothing, and no edge was ever built or shown (23.09.2026, diag: no error, edge created, nothing drawn). */
let _ticker = null;
function _ensureTicker() {
  const t = canvas.app?.ticker;
  if (!t || (t === _ticker)) return;
  try { _ticker?.remove(_tickEdges); } catch (_e) {}
  t.add(_tickEdges);
  _ticker = t;
}

/** The edge entry of a roof; its graphics lives in the primary group right above the tile. */
function _edgeFor(tile) {
  _ensureTicker();
  let e = _edges.get(tile.id);
  if (!e) _edges.set(tile.id, (e = { g: null, pieces: [], dirty: true, stats: null }));
  if (!e.g || e.g.destroyed || (e.g.parent !== canvas.primary)) {
    if (e.g && !e.g.destroyed) { try { e.g.destroy(); } catch (_e) {} }
    e.g = canvas.primary.addChild(new foundry.canvas.primary.PrimaryGraphics());
    e.g.sortLayer = canvas.primary.constructor.SORT_LAYERS.TILES;
    e.g.visible = false;
    e.dirty = true;
  }
  e.g.elevation = tile.mesh.elevation;
  e.g.sort = (tile.mesh.sort ?? 0) + 0.5;
  return e;
}

/** Is the point within `eps` px of one of the openings (door/window segments)? */
function _onOpening(p, openings, eps = 2) {
  for (const c of openings) {
    const dx = c[2] - c[0], dy = c[3] - c[1];
    const len2 = (dx * dx) + (dy * dy);
    const t = len2 > 0 ? Math.max(0, Math.min(1, (((p.x - c[0]) * dx) + ((p.y - c[1]) * dy)) / len2)) : 0;
    if (Math.hypot(c[0] + (t * dx) - p.x, c[1] + (t * dy) - p.y) <= eps) return true;
  }
  return false;
}

/** Stretches of the cut's boundary where the roof goes on past it: open polylines in canvas px. The openings'
 *  own lines are left out — the view starts there, it is not an edge of the roof. */
function _edgeRuns(mesh, union, openings = []) {
  const runs = [];
  for (const path of union) {
    const pts = path.map((p) => ({ x: p.X / SF, y: p.Y / SF }));
    let run = null, last = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / EDGE_STEP));
      for (let k = 0; k <= n; k++) {
        const p = { x: a.x + (((b.x - a.x) * k) / n), y: a.y + (((b.y - a.y) * k) / n) };
        if (mesh.containsCanvasPoint(p, ALPHA) && !_onOpening(p, openings)) {
          if (!run) runs.push((run = [p]));
          else if (k === n) run.push(p); // a corner of the cut
          last = p;
        } else if (run) {
          if (run.at(-1) !== last) run.push(last); // the roof ends here
          run = null;
        }
      }
    }
    if (run && (run.at(-1) !== last)) run.push(last);
  }
  return runs.filter((r) => r.length > 1);
}

/** Fill Clipper polygons (a PolyTree: outer rings with their holes). Rings under `minArea` canvas px² are
 *  skipped — the fog's slivers along the cone's rays (rounding between the hull and the cut) would draw
 *  hairlines. */
function _fillTree(g, node, minArea = 0) {
  for (const child of node.Childs()) {
    const ring = child.Contour();
    if (minArea && (Math.abs(ClipperLib.Clipper.Area(ring)) / (SF * SF)) < minArea) continue;
    g.drawPolygon(ring.flatMap((p) => [p.X / SF, p.Y / SF]));
    for (const hole of child.Childs()) {
      if (typeof g.beginHole !== "function") break;
      g.beginHole();
      g.drawPolygon(hole.Contour().flatMap((p) => [p.X / SF, p.Y / SF]));
      g.endHole();
      _fillTree(g, hole, minArea); // islands inside a hole
    }
  }
}

/** Build the edge graphics from the cut pieces: the cut past the openings → stretches under the roof →
 *  fog, shadow bands, line. */
function _buildEdge(e, mesh) {
  const g = e.g;
  g.clear();
  e.stats = { pieces: e.pieces.length, runs: 0, bands: 0 };
  if (!e.pieces.length || !e.behind?.length) return;
  const PFT = ClipperLib.PolyFillType.pftNonZero;
  const clip = (type, subject, clipPaths, out = new ClipperLib.Paths()) => {
    const c = new ClipperLib.Clipper();
    c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    if (clipPaths) c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
    c.Execute(type, out, PFT, PFT);
    return out;
  };
  // One edge round the whole cut: every door and viewer adds a piece, the pieces overlap. The edge lives only
  // PAST the openings — the front strips (and the door lines) get no frame, no shadow, no fog.
  const union = clip(ClipperLib.ClipType.ctUnion, e.pieces);
  const past = clip(ClipperLib.ClipType.ctIntersection, union, e.behind);
  if (!past.length) return;

  if (e.fog) {
    // Unseen inside the view: (convex outline of the view ∩ past the openings) − the cut. The outline keeps
    // the fog to the room seen through the opening — beyond its own walls the roof stays roof.
    const hull = _hull(past);
    if (hull) {
      const ch = new ClipperLib.Clipper();
      ch.AddPath(hull, ClipperLib.PolyType.ptSubject, true);
      ch.AddPaths(e.behind, ClipperLib.PolyType.ptClip, true);
      const within = new ClipperLib.Paths();
      ch.Execute(ClipperLib.ClipType.ctIntersection, within, PFT, PFT);
      const cf = new ClipperLib.Clipper();
      cf.AddPaths(within, ClipperLib.PolyType.ptSubject, true);
      cf.AddPaths(union, ClipperLib.PolyType.ptClip, true);
      const fog = new ClipperLib.PolyTree();
      cf.Execute(ClipperLib.ClipType.ctDifference, fog, PFT, PFT);
      e.stats.fog = fog.Total();
      g.beginFill(0x000000, 1);
      _fillTree(g, fog, 16);
      g.endFill();
    }
  }

  const runs = _edgeRuns(mesh, past, e.openings ?? []);
  e.stats.runs = runs.length;
  if (!runs.length) return;
  const size = canvas.grid?.size ?? 100;

  if (_setting(S_SHADOW)) {
    // Nested bands around the stretches, each cut to the inside of the cut: overlapping, they darken
    // toward the edge — a soft shadow the roof casts into the room.
    const open = runs.map((r) => r.map((p) => ({ X: Math.round(p.x * SF), Y: Math.round(p.y * SF) })));
    const depth = size * 0.6;
    for (let i = 1; i <= SHADOW_BANDS; i++) {
      const co = new ClipperLib.ClipperOffset(2, 0.25 * SF);
      // Butt ends: a round cap would spill past the stretch's end — out from under the roof onto the deck.
      co.AddPaths(open, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenButt);
      const band = new ClipperLib.Paths();
      co.Execute(band, (depth * i * SF) / SHADOW_BANDS);
      // Cut to the view past the openings: a band starting at a door end must not reach back over the door.
      const inside = clip(ClipperLib.ClipType.ctIntersection, band, past, new ClipperLib.PolyTree());
      g.beginFill(0x000000, SHADOW_BAND_ALPHA);
      _fillTree(g, inside);
      g.endFill();
      e.stats.bands++;
    }
  }

  if (_setting(S_OUTLINE)) {
    g.lineStyle({ width: Math.max(2, size * 0.06), color: 0x000000, alpha: 1,
      cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    for (const r of runs) {
      g.moveTo(r[0].x, r[0].y);
      for (let i = 1; i < r.length; i++) g.lineTo(r[i].x, r[i].y);
    }
    g.lineStyle(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens ON the roof inside the cut
// ─────────────────────────────────────────────────────────────────────────────
// 23.09.2026: a token standing on the roof (at 15, on the grate) over the cut looked like it stood INSIDE the
// room the cut opens — the user picked «hide them while hovering» over «keep a piece of roof under them». They
// fade out with the roof and come back with it. Pointing at such a token brings the roof back by itself: core
// drops the PCOs under the hovered placeable from the hover list (groups/primary.mjs #updateHoveredObjects),
// the roof stops fading — and the token with it. Alpha goes through Token#_getTargetAlpha (see onReady):
// core applies it to the token (bars, name, effects) and to its mesh on every refreshState.
// The mirror case — a token UNDER the roof — shows only as much as the roof over it is faded. The roof covers
// its mesh anyway, but not what lives above the roof: the token's name, border, effects and the system's GM
// markers (canvas.interface) hung over an unhovered roof above Celeste, seen through an open door (23.09.2026).

/** tileId → { polys: the cut as flat canvas-px polygons, elevation: the roof's }, from the last mask redraw. */
const _cutAreas = new Map();
/** Ids of the tiles above a partial roof whose silhouette is in the mask right now (see _redraw, onReady). */
const _aboveRoofs = new Set();
/** tokenId → alpha factor (< 1) of a token standing on a hover-cut roof, or under a roof not faded over it. */
const _hidden = new Map();

/** For the pathfinder's goal floor (main.mjs __admGoalFloor): is the point inside this partial roof's cut?
 *  Null — not a partial roof we track (the caller decides by other means). */
globalThis.__admPartialFadeCutAt = (tileId, x, y) => {
  const area = _cutAreas.get(tileId);
  if (!area) return null;
  return area.polys.some((p) => _inPoly(p, x, y));
};

function _inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (((yi > y) !== (yj > y)) && (x < ((((xj - xi) * (y - yi)) / (yj - yi)) + xi))) c = !c;
  }
  return c;
}

/** The tokens that fade a partial roof whole: core's occluders, less a token that is only HOVERED (see onReady). A
 *  token that occludes for another reason (controlled, owned under OWNED mode, everyone under VISIBLE/highlight)
 *  still counts. */
function _roofOccluders(tokens) {
  const hov = canvas.tokens?.hover;
  if (!hov || hov.controlled || !tokens?.includes?.(hov)) return tokens ?? [];
  const M = CONST.TOKEN_OCCLUSION_MODES;
  const mode = canvas.tokens.occlusionMode;
  if ((mode & M.VISIBLE) || ((mode & M.HIGHLIGHTED) && canvas.tokens.highlightObjects)) return tokens;
  if ((mode & M.OWNED) && hov.isOwner && !hov.document.hidden) return tokens;
  return tokens.filter((t) => t !== hov);
}

/** Does the token's move END under this roof? Core's occlusion test (primary-occludable-object.mjs testOcclusion:
 *  below the roof; the centre or, for a light+weather roof, one of eight edge points inside it) at the committed
 *  position: while a move animates, the document holds the frame's position and _source the destination. */
function _endsUnder(pco, token, corners) {
  const dest = token.document?._source;
  if (!dest || ((Number(dest.elevation) || 0) >= pco.elevation)) return false;
  const { w, h } = token;
  const pts = [[w / 2, h / 2]];
  if (corners) {
    const p = 2;
    pts.push([p, p], [w / 2, p], [w - p, p], [w - p, h / 2], [w - p, h - p], [w / 2, h - p], [p, h - p], [p, h / 2]);
  }
  return pts.some(([tx, ty]) => pco.containsCanvasPoint({ x: dest.x + tx, y: dest.y + ty }));
}

/** Core's occluded set, corrected for partial roofs (see onReady). Such a roof stays in the set only while a token
 *  under it also ENDS its move under it — stands there, or walks in to stop there — and then fades whole at once.
 *  A token passing under it or brushing its edge (the move ends outside) and a token that is only hovered take it out:
 *  core leaves it unfaded, and Better Roofs keeps showing it through the fog. The way out stays with core's debounce
 *  (a token leaving its roof is not under it at the end, the roof is dropped, core clears «occluded» after the stop). */
function _partialOcclusion(occluded, tokens) {
  if (!occluded?.size) return;
  const occluders = _roofOccluders(tokens);
  for (const pco of [...occluded]) {
    const tile = pco.object;
    if (!(tile instanceof foundry.canvas.placeables.Tile) || !_isPartial(tile.document)) continue;
    const corners = pco.restrictsLight && pco.restrictsWeather;
    if (!occluders.some((t) => pco.testOcclusion(t, { corners }) && _endsUnder(pco, t, corners))) occluded.delete(pco);
    else if (!pco.occluded) pco.occluded = true;
  }
}

/** Every frame: which tokens stand on a faded roof, and how faded — the roof under them is gone either way:
 *  • whole (fade channel): a token UNDER the roof occludes it — the viewer inside, or a HOVERED one: core's
 *    token occlusion mode counts the hovered token (layers/tokens.mjs _getOccludableTokens, M.HOVERED), and a
 *    token pointed at inside the room faded the whole roof — Lilith on it showed up again (23.09.2026);
 *  • cut (vision channel): the hover cut — only inside the cut.
 *  A token under the roof gets the opposite: it shows as much as the roof over it is faded. */
function _tickHide() {
  const next = new Map();
  const onRoof = _setting(S_HIDE);
  for (const [id, area] of _cutAreas) {
    const tile = canvas.tiles?.get(id);
    const mesh = tile?.mesh;
    if (!tile?.visible || !mesh?.visible) continue;
    const st = mesh._occlusionState;
    const whole = st ? st.fade : 0;
    const cut = st ? st.vision : 0;
    for (const t of canvas.tokens?.placeables ?? []) {
      if (!t.visible || t.isPreview) continue;
      // The viewer's own token is never hidden — under the roof or ON it: Ivy on the forecastle (15) vanished with
      // the roof when it faded whole (24.09.2026).
      if (t.controlled) continue;
      const above = (Number(t.document.elevation) || 0) >= area.elevation; // on the roof or above it
      if (above && !onRoof) continue;
      const c = t.center;
      if (!mesh.containsCanvasPoint(c, ALPHA)) continue;
      const inCut = (cut > 0.01) && area.polys.some((p) => _inPoly(p, c.x, c.y));
      const amount = Math.max(whole, inCut ? cut : 0);
      const f = above ? 1 - amount : amount;
      if (!(f < 0.99)) continue;
      next.set(t.id, Math.min(next.get(t.id) ?? 1, f));
    }
  }
  // Refresh the tokens whose factor changed; the map is updated first — the refresh reads it later this frame.
  const changed = [];
  for (const [tid, f] of next) if (_hidden.get(tid) !== f) changed.push(tid);
  for (const tid of _hidden.keys()) if (!next.has(tid)) changed.push(tid);
  _hidden.clear();
  for (const [tid, f] of next) _hidden.set(tid, f);
  for (const tid of changed) canvas.tokens?.get(tid)?.renderFlags.set({ refreshState: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow UNDER a plain tile
// ─────────────────────────────────────────────────────────────────────────────
// The same per-tile box on a tile WITHOUT partial fade (23.09.2026, the middle mast). Better Roofs shows such a
// tile through the dark by putting its silhouette into the vision mask BY THE TEXTURE ALPHA
// (betterroofs/scripts/helpers.js showTileThroughFog: white × alpha), so every see-through pixel of the picture —
// sail shadows, rope edges, a soft halo — lifted the dark in proportion, and the deck behind the mast's own walls
// showed through. The user: «the shadow up to 29, and the tile on top of it».
// ⚠️ The first try — a black copy of the tile right under it, alpha ×10 — blackened the faint halo over the whole
// box too, and on floor 0, where Levels draws the floor's unseen part as explored (dim), it was a black box inside
// a grey shadow (24.09.2026). Now the reveal itself is cut: for a tile with the box only its solid pixels
// (alpha ≈ 1) lift the dark; under the see-through ones the shadow is whatever it is around them.

function _isShadowTile(doc) {
  return !!doc?.flags?.[MODULE_ID]?.[FLAG_FOG] && !_isPartial(doc);
}

let _solidOnly = null;
/** White where the reveal sprite is solid, nothing where it is see-through: 10·a − 4.5, clamped on output —
 *  a step around alpha 0.5. Not higher: the mast's crow's nest has planks at alpha 0.5–1 (11 % of the disc),
 *  a stricter cut striped it with the shadow. */
function _solidOnlyFilter() {
  if (!_solidOnly) {
    _solidOnly = new PIXI.ColorMatrixFilter();
    _solidOnly.matrix = [0, 0, 0, 10, -4.5, 0, 0, 0, 10, -4.5, 0, 0, 0, 10, -4.5, 0, 0, 0, 10, -4.5];
  }
  return _solidOnly;
}

/** Cut the Better Roofs reveal sprites of the tiles with the box; the others are left as Better Roofs made them.
 *  Its sprites are named by tile id and live in the vision mask (roofs.js initializePIXIcontainers). */
function _cutReveals(enabled) {
  const box = canvas?.masks?.vision?.children?.find((c) => c.name === "fogRoofContainer");
  if (!box) return;
  let changed = false;
  for (const sprite of box.children) {
    const tile = canvas.tiles?.get(sprite.name);
    const want = enabled && !!tile && _isShadowTile(tile.document);
    const has = !!_solidOnly && !!sprite.filters?.includes?.(_solidOnly);
    if (want && !has) { sprite.filters = [_solidOnlyFilter()]; changed = true; }
    else if (!want && has) { sprite.filters = null; changed = true; }
  }
  if (changed) canvas.masks.vision.renderDirty = true; // the vision mask does not re-render by itself
}

/** Every frame: the edge shows as much as the roof is hover-faded through the mask, and not at all when the
 *  roof fades whole (fade channel: a token under it, or no vision to cut by). Built on the first such frame. */
function _tickEdges() {
  try { _tickHide(); } catch (err) { _lastError = err; }
  for (const [id, e] of _edges) {
    try {
      const g = e.g;
      if (!g || g.destroyed) { _edges.delete(id); continue; }
      const tile = canvas.tiles?.get(id);
      const mesh = tile?.mesh;
      const st = mesh?._occlusionState;
      const a = st ? (st.vision * (1 - st.fade)) : 0;
      const show = (a > 0.01) && !!tile.visible && !!mesh.visible;
      if (show && e.dirty) { e.dirty = false; _buildEdge(e, mesh); }
      g.alpha = a;
      g.visible = show;
    } catch (err) {
      _lastError = err;
      e.dirty = false;
      console.warn("[adm-levels] partial fade: edge", err);
    }
  }
}

/** Console diagnostics: __admPartialFade.diag(). */
globalThis.__admPartialFade = {
  diag() {
    return {
      build: globalThis.__ADM_BUILD?.admLevels,
      outline: _setting(S_OUTLINE),
      shadow: _setting(S_SHADOW),
      lastError: _lastError ? String(_lastError?.stack ?? _lastError) : null,
      edges: [..._edges].map(([id, e]) => ({
        tile: id, fog: !!e.fog, pieces: e.pieces?.length ?? 0, dirty: e.dirty, stats: e.stats,
        alpha: e.g?.alpha, visible: e.g?.visible, inPrimary: e.g?.parent === canvas.primary,
        index: e.g?.parent ? e.g.parent.children.indexOf(e.g) : -1,
        roofIndex: canvas.primary?.children?.indexOf(canvas.tiles?.get(id)?.mesh),
        hover: canvas.tiles?.get(id)?.mesh?._occlusionState,
      })),
      reveals: (canvas.masks?.vision?.children?.find((c) => c.name === "fogRoofContainer")?.children ?? [])
        .map((s) => ({ tile: s.name, cut: !!_solidOnly && !!s.filters?.includes?.(_solidOnly) })),
    };
  },
};

/** Redraw our layers of the occlusion mask (called right after core's _updateOcclusionMask). */
function _redraw(mask, enabled) {
  const L = _layers(mask);
  L.cuts.clear();
  const live = new Set();
  const liveSprites = new Set();
  _aboveRoofs.clear();
  const edgeAll = enabled && (_setting(S_OUTLINE) || _setting(S_SHADOW)); // module-wide; the fog is per tile
  const liveEdges = new Set();
  if (enabled) {
    const tiles = (canvas.tiles?.placeables ?? []).filter((t) => _isPartial(t.document)
      && t.visible && t.mesh?.visible && (t.mesh.texture?.valid !== false));
    const viewers = tiles.length
      ? (canvas.tokens?._getOccludableTokens?.() ?? []).filter((t) => t.vision?.active && t.vision.los)
      : [];
    const marks = tiles.length ? (canvas.walls?.placeables ?? []).filter((w) => _isDoorOrWindow(w.document)) : [];
    if (tiles.length) _ensureTicker(); // hiding tokens on the roof needs it even with every edge option off
    for (const tile of tiles) {
      // ⚠️ The silhouette keeps the roof whole outside the cuts — needed only against a viewer BELOW it, the only
      // one that dissolves it. It sits in the SHARED vision channel, so it also kept everything above the roof from
      // dissolving over it: with Lilith standing on the stern castle (15), a hovered mast (25) faded only where it
      // stuck out past the roof (24.09.2026). No viewer below — no silhouette.
      if (viewers.some((t) => t.document.elevation < tile.document.elevation)) {
        _syncSprite(L, tile);
        liveSprites.add(tile.id);
      }
      live.add(tile.id);
      const pieces = [];
      const behind = [];   // the views past the openings: the only place the edge (outline, shadow, fog) lives
      const openings = []; // their segments: the view starts there, it is not an edge of the roof
      for (const token of viewers) {
        if (!(token.document.elevation < tile.document.elevation)) continue; // core occludes only for tokens below
        const value = Math.round(mask.mapElevation(token.document.elevation) * 255);
        const los = token.vision.los;
        const eye = Number(token.losHeight ?? token.document.elevation);
        for (const w of marks) {
          const c = w.document.c;
          if (!_atEye(w.document, eye) || !_underRoof(tile.mesh, c)) continue;
          const view = _behind(los.origin, c);
          _cut(L.cuts, los, view, value, pieces);
          _cut(L.cuts, los, _front(los.origin, c), value, pieces);
          if (view) {
            // ⚠️ One winding for all: a wedge winds with the door's point order, and under the non-zero fill
            // two overlapping wedges of opposite winding cancel out — the fog skipped exactly the room behind
            // an inner door, where its wedge overlapped the front door's (23.09.2026, «Деревня»).
            const pts = view.toClipperPoints({ scalingFactor: SF });
            if (!ClipperLib.Clipper.Orientation(pts)) pts.reverse();
            behind.push(pts);
          }
          openings.push(c);
        }
      }
      const fog = !!tile.document.flags?.[MODULE_ID]?.[FLAG_FOG];
      if (edgeAll || fog) {
        const e = _edgeFor(tile);
        e.pieces = pieces;
        e.behind = behind;
        e.openings = openings;
        e.fog = fog;
        e.dirty = true; // rebuilt on the next hovered frame (_tickEdges)
        liveEdges.add(tile.id);
      }
      _cutAreas.set(tile.id, {
        polys: pieces.map((p) => p.flatMap((q) => [q.X / SF, q.Y / SF])),
        elevation: Number(tile.document.elevation) || 0,
      });
    }
    // With a viewer below, the silhouette stays — and still holds shut, over the roof, the vision channel a
    // hovered tile ABOVE the roof dissolves in. Such tiles are faded whole by hover instead (see onReady).
    const shields = tiles.filter((t) => liveSprites.has(t.id));
    if (shields.length) {
      for (const t of canvas.tiles?.placeables ?? []) {
        if (_isPartial(t.document) || !t.mesh?.hoverFade) continue;
        const z = Number(t.document.elevation) || 0;
        const b = t.mesh.canvasBounds;
        if (shields.some((r) => (z > (Number(r.document.elevation) || 0)) && b?.intersects?.(r.mesh.canvasBounds))) {
          _aboveRoofs.add(t.id);
        }
      }
    }
  }
  for (const [id, s] of L.sprites) {
    if (liveSprites.has(id)) continue;
    L.sprites.delete(id);
    try { s.destroy(); } catch (_e) {}
  }
  for (const id of [..._edges.keys()]) if (!liveEdges.has(id)) _dropEdge(id);
  for (const id of [..._cutAreas.keys()]) if (!live.has(id)) _cutAreas.delete(id);
  mask.renderDirty = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI: the extra entry in the tile config occlusion list
// ─────────────────────────────────────────────────────────────────────────────
function _injectConfig(app, html) {
  if (app?.meForm) return; // Mass Edit builds its own form on top of TileConfig and saves in its own way
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  const select = root?.querySelector?.('select[name="occlusion.mode"]');
  if (!select || select.querySelector("option[data-adm-partial-fade]")) return;
  const FADE = String(CONST.OCCLUSION_MODES.FADE);
  const fadeOpt = [...select.options].find((o) => o.value === FADE);
  if (!fadeOpt) return;
  const L = (k) => game.i18n.localize(`ADM_LEVELS.tilePartialFade.${k}`);

  const opt = document.createElement("option");
  opt.value = FADE;
  opt.dataset.admPartialFade = "1";
  opt.textContent = L("option");
  fadeOpt.after(opt);

  // Both entries submit FADE; the hidden box says which one is picked. No hint lines (the user: «remove the
  // hints» — the module settings explain the mode).
  const box = document.createElement("input");
  box.type = "checkbox";
  box.name = `flags.${MODULE_ID}.${FLAG}`;
  box.hidden = true;
  const group = select.closest(".form-group") ?? select.parentElement;
  group.append(box);

  // Per tile, one box for two modes: «Partial fade» — what is unseen inside the cut is black; any other mode —
  // what is unseen right under the tile is black, the tile itself stays on top (a mast over its own walls' shadow).
  const fogRow = document.createElement("div");
  fogRow.className = "form-group";
  const fogLabel = document.createElement("label");
  fogLabel.textContent = L("fog");
  const fogFields = document.createElement("div");
  fogFields.className = "form-fields";
  const fogBox = document.createElement("input");
  fogBox.type = "checkbox";
  fogBox.name = `flags.${MODULE_ID}.${FLAG_FOG}`;
  fogBox.checked = !!app.document?.flags?.[MODULE_ID]?.[FLAG_FOG];
  fogFields.append(fogBox);
  fogRow.append(fogLabel, fogFields);
  group.after(fogRow);

  if (_isPartial(app.document)) opt.selected = true;
  const sync = () => {
    const on = select.selectedOptions[0] === opt;
    box.checked = on;
    fogLabel.textContent = on ? L("fog") : L("shadowUnder");
  };
  select.addEventListener("change", sync);
  sync();
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ─────────────────────────────────────────────────────────────────────────────
export const TOOL = {
  id: "tilePartialFade",
  name: "ADM_LEVELS.settings.tilePartialFade.name",
  hint: "ADM_LEVELS.settings.tilePartialFade.hint",

  onInit() {
    // More checkboxes of the sub-module: the black outline, the inner shadow and the fog inside the cut.
    const remask = () => {
      for (const e of _edges.values()) e.dirty = true;
      try { canvas.perception?.update?.({ refreshOcclusionMask: true }); } catch (_e) {}
    };
    for (const [key, i18n] of [[S_OUTLINE, "tilePartialFadeOutline"], [S_SHADOW, "tilePartialFadeShadow"],
      [S_HIDE, "tilePartialFadeHideOnRoof"]]) {
      game.settings.register(MODULE_ID, key, {
        name: `ADM_LEVELS.settings.${i18n}.name`,
        hint: `ADM_LEVELS.settings.${i18n}.hint`,
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: remask,
      });
    }
  },

  onReady({ isEnabled }) {
    const remask = () => { try { canvas.perception?.update?.({ refreshOcclusionMask: true }); } catch (_e) {} };

    // The edge follows the roof's hover fade frame by frame: the ticker is attached with the first edge
    // (_ensureTicker) — this runs on SETUP, the canvas does not exist yet.
    // The primary group is rebuilt with the scene: our edges go with it (and the cut areas, the hidden tokens).
    Hooks.on("canvasTearDown", () => {
      for (const id of [..._edges.keys()]) _dropEdge(id);
      _cutAreas.clear();
      _aboveRoofs.clear();
      _hidden.clear();
    });

    try {
      if (globalThis.libWrapper?.register) {
        libWrapper.register(
          MODULE_ID,
          "foundry.canvas.layers.CanvasOcclusionMask.prototype._updateOcclusionMask",
          function (wrapped, ...args) {
            const result = wrapped(...args);
            try { _redraw(this, isEnabled()); } catch (e) { _lastError = e; console.warn("[adm-levels] partial fade:", e); }
            return result;
          },
          "WRAPPER",
        );
        // ⚠️ A token that is only HOVERED does not fade a partial roof whole. Core counts hovered tokens as
        // occluders for the GM only (layers/tokens.mjs: GM → CONTROLLED | HOVERED | HIGHLIGHTED, player →
        // OWNED): pointing at a token inside the room faded the whole roof, and everything outside the
        // selected token's view went black — the roof and the black took turns as the cursor moved, «a disco»
        // on the GM's screen only (23.09.2026, video). The player's picture: the hover cut stays.
        // ⚠️ And a token walking in to stop under the roof fades it whole AT ONCE. Core sets the occluded state
        // through a 50 ms debounce (primary-occludable-object.mjs debounceSetOcclusion), and a moving token calls it
        // every animation frame — so the whole fade waited for the move to end. The partial cut does not cover that
        // gap: from an eye inside, the view past the door is the street, not the room. The roof stayed over the room
        // and the token walked on under it until it stopped (24.09.2026, video, pumpkin).
        // ⚠️ A token passing under the roof or brushing its edge (the move ends outside) does not count at all. Better
        // Roofs wraps this very method (occlusionlink.js) and takes every roof in the set out of its «roof through
        // the fog» sprite at once — and it runs AFTER sightRefresh in the frame (perception-manager: vision, then
        // occlusion), so its word is the last: whatever of the roof the token did not see went black while a corner
        // of the token was over the roof's edge (24.09.2026, second video; it was so before us).
        // ⚠️ MIXED, not WRAPPER: libWrapper calls MIXED after every WRAPPER, i.e. closer to core — Better Roofs'
        // WRAPPER gets the set we corrected. As a WRAPPER ours could run outside it, after its hide was done.
        libWrapper.register(
          MODULE_ID,
          "foundry.canvas.layers.CanvasOcclusionMask.prototype._identifyOccludedObjects",
          function (wrapped, tokens, ...args) {
            const occluded = wrapped(tokens, ...args);
            try { if (isEnabled()) _partialOcclusion(occluded, tokens); } catch (e) { _lastError = e; }
            return occluded;
          },
          "MIXED",
        );
        // A token on a hover-cut roof fades with it (see «Tokens ON the roof»). Wrapped where it is defined
        // (PlaceableObject); only tokens, not the drag ghost.
        libWrapper.register(
          MODULE_ID,
          "foundry.canvas.placeables.PlaceableObject.prototype._getTargetAlpha",
          function (wrapped, ...args) {
            const alpha = wrapped(...args);
            if (!_hidden.size || this.isPreview || !(this instanceof foundry.canvas.placeables.Token)) return alpha;
            const f = _hidden.get(this.id);
            return (f === undefined) ? alpha : alpha * f;
          },
          "WRAPPER",
        );
      }
    } catch (e) { console.warn("[adm-levels] partial fade: wrappers", e); }

    // Hover fades WHOLE (through the shared wrapper — libWrapper allows one per package per method):
    // • a tile above a roof whose silhouette is in the mask: the core dissolves it in the vision channel, which the
    //   silhouette keeps shut over the roof (see _aboveRoofs in _redraw);
    // • a tile with «Black shadow under the tile»: the core's dissolve reaches only as far as the token sees, and
    //   in the shadow the mast's picture stayed where the dark was wanted (24.09.2026).
    addTileFade((mesh, tile) => {
      if (!isEnabled() || !mesh.hoverFade) return 0;
      if (!_aboveRoofs.has(tile.id) && !_isShadowTile(tile.document)) return 0;
      return Number(mesh._hoverFadeState?.occlusion) || 0;
    });

    Hooks.on("renderTileConfig", (app, html) => {
      if (!isEnabled()) return;
      try { _injectConfig(app, html); } catch (e) { console.warn("[adm-levels] partial fade: config", e); }
    });

    // The mask is redrawn by core on every vision change (a door opening included); tile edits are ours to report.
    Hooks.on("updateTile", (doc, changed) => {
      if (!isEnabled()) return;
      if (_isPartial(doc) || foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.${FLAG}`)
        || ("occlusion" in (changed ?? {}))) remask();
      try { _cutReveals(true); } catch (e) { _lastError = e; }
    });
    Hooks.on("refreshTile", (tile) => { if (isEnabled() && _isPartial(tile?.document)) remask(); });
    Hooks.on("deleteTile", (doc) => { if (isEnabled() && _isPartial(doc)) remask(); });
    // Better Roofs (re)creates its reveal sprites on sightRefresh — its hook is registered at load, before ours,
    // so ours runs after it and finds them ready.
    Hooks.on("sightRefresh", () => { try { _cutReveals(isEnabled()); } catch (e) { _lastError = e; } });
    Hooks.on("canvasReady", () => { if (isEnabled()) remask(); });
  },
};
