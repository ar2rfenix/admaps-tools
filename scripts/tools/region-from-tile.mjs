// scripts/tools/region-from-tile.mjs
// ADMaps Tools sub-module: «Region from tile».
//
// WHY. A roof or a platform is a tile with transparent edges. To make it a floor,
// it needs a plateau region of the same shape and elevation underneath. By hand
// that is tracing cells for dozens of clicks, and it still comes out crooked.
//
// WHAT IT DOES. A button in the region tools: press → click a tile → the region
// is ready. Elevation range = tile elevation (15 → «15–15»), type «Plateau» at the
// same height. The shape is traced from the OPACITY of the tile image:
//   • cell more than half opaque → take it whole;
//   • opaque roughly along a diagonal (bevelled edge) → take a half-cell triangle;
//   • less — skip it.
// The half-cell threshold drops shadows, sparks and stray grass: they are either
// semi-transparent or occupy a small part of the cell.
//
// Binding the region to the tile (Mass Edit etc.) is NOT done — that is separate
// work and easier to finish by hand.

const MODULE_ID = "adm-levels";
const FLAG_TYPE = "type";
const FLAG_ELEVATION = "elevation";

// Sampling density inside a cell: 8×8 = 64 probes. No need for more — the decision
// is made by ratio, not by individual pixels.
const SAMPLES = 8;
// Semi-transparent (shadow, haze, soft edge) does not count as material.
const ALPHA_MIN = 128;
// Full cell — as the user asked: more than half.
const FULL_COVER = 0.51;
// Solid cell: no point looking for a triangle in it.
const SOLID_COVER = 0.92;
// Below this we do not even consider it a diagonal — grass and sparks.
const MIN_COVER = 0.15;
// Bevel candidate: the opaque area lies mostly in one half of the cell, and that
// half is densely filled. Thresholds are soft ON PURPOSE — neighbours decide, not they.
// ⚠️ Keeping them low matters: on a shallow diagonal the cell is covered by a narrow
// strip (measured: 0.33), and strict thresholds dropped it entirely — a step appeared
// instead of a bevel.
const CUT_OF_HITS = 0.50;
const CUT_FILL = 0.38;
// A cell covered less than half can still become a bevel: half a cell is exactly
// a half. Below this — empty.
// ⚠️ Kept low: on a cut corner the outermost cell may be covered by only 0.23, and
// the corner came out chopped by a cell. What protects from grass and sparks is not
// this threshold but the requirement of a busy neighbour — a lone tuft won't become a bevel.
const CUT_MIN_COVER = 0.20;

const HEIGHT_KEYS = [
  { key: "veryFar", ft: 120 }, { key: "far", ft: 60 }, { key: "medium", ft: 30 },
  { key: "close", ft: 15 }, { key: "", ft: 0 },
  { key: "-close", ft: -15 }, { key: "-medium", ft: -30 },
  { key: "-far", ft: -60 }, { key: "-veryFar", ft: -120 },
];

/** Plateau colour by elevation — the same ladder of thresholds as in the region window. */
function _plateauColor(ft) {
  const abs = Math.abs(Number(ft) || 0);
  if (abs <= 15) return "#22c55e";
  if (abs <= 30) return "#eab308";
  if (abs <= 60) return "#f97316";
  return "#ef4444";
}

/** Feet → elevation key in the form the module stores it. */
function _ftToKey(ft) {
  const n = Number(ft) || 0;
  const known = HEIGHT_KEYS.find(h => h.ft === n);
  return known ? known.key : String(n);
}

/* ------------------------------------------------------------------ */
/*  Tile pick by click                                                */
/* ------------------------------------------------------------------ */

function _tileAt(pt) {
  const list = [...(canvas?.tiles?.placeables ?? [])];
  // Top to bottom: what is drawn higher comes first.
  list.sort((a, b) => (Number(b.document?.elevation) || 0) - (Number(a.document?.elevation) || 0)
    || (Number(b.document?.sort) || 0) - (Number(a.document?.sort) || 0));
  for (const t of list) {
    try {
      // By OPACITY, not by bounding box: a roof has empty corners, and a click on
      // a corner must reach the tile below it, not this roof.
      if (t.mesh?.containsCanvasPoint?.(pt, 0.05)) return t;
    } catch (_e) {}
  }
  // Nothing caught by alpha — try by bounds (the video has not loaded yet).
  for (const t of list) {
    const d = t.document;
    if (!d) continue;
    if (pt.x >= d.x && pt.y >= d.y && pt.x <= d.x + d.width && pt.y <= d.y + d.height) return t;
  }
  return null;
}

function _pickTile() {
  return new Promise((resolve) => {
    const stage = canvas?.stage;
    if (!stage) return resolve(null);
    const done = (v) => { cleanup(); resolve(v); };
    const onDown = (ev) => {
      const btn = ev?.data?.button ?? ev?.button ?? 0;
      if (btn !== 0) return done(null);
      ev.stopPropagation?.();
      let p = null;
      try { p = ev.data.getLocalPosition(stage); } catch (_e) {}
      done(p ? _tileAt(p) : null);
    };
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    function cleanup() {
      try { stage.off("pointerdown", onDown); } catch (_e) {}
      document.removeEventListener("keydown", onKey, true);
    }
    stage.on("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
  });
}

/* ------------------------------------------------------------------ */
/*  Snapshot of tile pixels                                           */
/* ------------------------------------------------------------------ */

/**
 * Read the SOURCE tile image into pixels.
 *
 * ⚠️ Not via PIXI extraction of the rendered mesh: tiles have their own occlusion
 * shader, and the snapshot came out empty — every cell counted as transparent.
 * We read the file itself (or the current video frame) and recompute coordinates ourselves.
 */
function _grabTilePixels(tile) {
  try {
    const res = tile?.texture?.baseTexture?.resource;
    const src = res?.source ?? res?.bitmap ?? null;
    const iw = Number(src?.naturalWidth ?? src?.videoWidth ?? src?.width) || 0;
    const ih = Number(src?.naturalHeight ?? src?.videoHeight ?? src?.height) || 0;
    if (!src || !iw || !ih) return null;
    const cnv = document.createElement("canvas");
    cnv.width = iw; cnv.height = ih;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, iw, ih);
    const data = ctx.getImageData(0, 0, iw, ih).data;

    const d = tile.document;
    const rotRad = -((Number(d.rotation) || 0) * Math.PI) / 180;   // undo the rotation
    return {
      data, iw, ih,
      dx: Number(d.x) || 0, dy: Number(d.y) || 0,
      dw: Number(d.width) || 0, dh: Number(d.height) || 0,
      cos: Math.cos(rotRad), sin: Math.sin(rotRad),
      flipX: (Number(d.texture?.scaleX) || 1) < 0,
      flipY: (Number(d.texture?.scaleY) || 1) < 0,
    };
  } catch (e) {
    console.warn("[adm-levels] region from tile: pixel snapshot failed", e);
    return null;
  }
}

/** Tile bounds on the scene, accounting for rotation. */
function _tileBox(snap) {
  const cx = snap.dx + snap.dw / 2, cy = snap.dy + snap.dh / 2;
  const hw = snap.dw / 2, hh = snap.dh / 2;
  // Reverse rotation has the same magnitude; the sign does not matter for bounds.
  const c = Math.abs(snap.cos), s = Math.abs(snap.sin);
  const w = hw * c + hh * s, h = hw * s + hh * c;
  return { x: cx - w, y: cy - h, w: w * 2, h: h * 2 };
}

/** Whether a scene point is opaque. */
function _opaqueAt(snap, sx, sy) {
  const cx = snap.dx + snap.dw / 2, cy = snap.dy + snap.dh / 2;
  const ddx = sx - cx, ddy = sy - cy;
  // Into the coordinate system of the unrotated tile.
  const lx = ddx * snap.cos - ddy * snap.sin + snap.dw / 2;
  const ly = ddx * snap.sin + ddy * snap.cos + snap.dh / 2;
  if (lx < 0 || ly < 0 || lx >= snap.dw || ly >= snap.dh) return false;
  let u = lx / snap.dw, v = ly / snap.dh;
  if (snap.flipX) u = 1 - u;
  if (snap.flipY) v = 1 - v;
  const px = Math.min(snap.iw - 1, Math.max(0, Math.floor(u * snap.iw)));
  const py = Math.min(snap.ih - 1, Math.max(0, Math.floor(v * snap.ih)));
  return snap.data[(py * snap.iw + px) * 4 + 3] >= ALPHA_MIN;
}

/* ------------------------------------------------------------------ */
/*  Per-cell analysis                                                 */
/* ------------------------------------------------------------------ */

// Half-cell triangles: which part is opaque at a bevelled edge.
// Named by which CORNER stays filled.
const TRIANGLES = {
  tl: (u, v) => (u + v) <= 1,
  tr: (u, v) => (v <= u),
  br: (u, v) => (u + v) >= 1,
  bl: (u, v) => (v >= u),
};

/** Analyse one cell: coverage ratio + best bevel candidate. */
function _classifyCell(snap, cx, cy, gs) {
  const pts = [];
  let hits = 0;
  for (let iy = 0; iy < SAMPLES; iy++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const u = (ix + 0.5) / SAMPLES;
      const v = (iy + 0.5) / SAMPLES;
      const on = _opaqueAt(snap, cx + u * gs, cy + v * gs);
      if (on) hits++;
      pts.push({ u, v, on });
    }
  }
  const total = SAMPLES * SAMPLES;
  const cover = hits / total;
  if (cover >= SOLID_COVER || cover < MIN_COVER || hits === 0) return { cover, cand: null };

  // Find the half of the cell that the opaque area fits best. The decision
  // "cut or not" is made LATER, once the neighbours are known: from the cell alone
  // a diagonal cannot be told from a straight edge — measurement showed the
  // coverage ratio is the same for both (0.65–0.82).
  let probe = null;
  for (const [name, inside] of Object.entries(TRIANGLES)) {
    let inTri = 0, inTriHits = 0;
    for (const p of pts) {
      if (!inside(p.u, p.v)) continue;
      inTri++;
      if (p.on) inTriHits++;
    }
    if (!inTri) continue;
    const ofHits = inTriHits / hits;          // how much of the opaque area fell into the triangle
    const fill = inTriHits / inTri;           // how densely the triangle itself is filled
    if (!probe || ofHits + fill > probe.score) probe = { name, ofHits, fill, score: ofHits + fill };
  }
  const ok = !!probe && probe.ofHits >= CUT_OF_HITS && probe.fill >= CUT_FILL;
  return { cover, cand: ok ? probe : null };
}

/** Merge full cells into rectangles: first into rows, then rows vertically. */
function _mergeFull(full, cols, rows, ox, oy, gs) {
  const used = new Uint8Array(cols * rows);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!full[i] || used[i]) continue;
      // Run length to the right.
      let w = 1;
      while (c + w < cols && full[r * cols + c + w] && !used[r * cols + c + w]) w++;
      // How far the same run extends downward.
      let h = 1;
      outer: while (r + h < rows) {
        for (let k = 0; k < w; k++) {
          const j = (r + h) * cols + c + k;
          if (!full[j] || used[j]) break outer;
        }
        h++;
      }
      for (let rr = 0; rr < h; rr++) for (let cc = 0; cc < w; cc++) used[(r + rr) * cols + c + cc] = 1;
      out.push({
        type: "rectangle", hole: false, rotation: 0,
        x: Math.round(ox + c * gs), y: Math.round(oy + r * gs),
        width: Math.round(w * gs), height: Math.round(h * gs),
      });
    }
  }
  return out;
}

/** Half-cell triangle as a polygon. */
function _triShape(name, x, y, gs) {
  const P = {
    tl: [x, y, x + gs, y, x, y + gs],
    tr: [x, y, x + gs, y, x + gs, y + gs],
    br: [x + gs, y, x + gs, y + gs, x, y + gs],
    bl: [x, y, x + gs, y + gs, x, y + gs],
  }[name];
  return { type: "polygon", hole: false, points: P.map(v => Math.round(v)) };
}

/* ------------------------------------------------------------------ */
/*  Region assembly                                                   */
/* ------------------------------------------------------------------ */

/**
 * Restore our name, colour and elevations on the region and remove the foreign stair script.
 *
 * ⚠️ Levels hooks its `preCreateRegion` on the creation of ANY region: it replaces
 * the elevation range with the one selected in its panel, and with stairs enabled
 * it also renames the region to «Levels Stair X-Y» and adds an «Execute Script»
 * behavior calling RegionHandler.stair. Our plateau region fell under all of it.
 * That hook has no separate opt-out, so we fix things after creation: it attaches
 * the behavior deferred, via its own `Hooks.once("createRegion")`,
 * so we let it fire and then remove it.
 */
async function _undoLevelsHijack(region, name, color, ft) {
  const fix = async () => {
    try {
      const upd = {};
      if (region.name !== name) upd.name = name;
      if (region.color !== color) upd.color = color;
      const e = region.elevation ?? {};
      if (Number(e.bottom) !== ft || Number(e.top) !== ft) upd.elevation = { bottom: ft, top: ft };
      if (Object.keys(upd).length) await region.update(upd);

      const bad = (region.behaviors ?? []).filter(b =>
        b?.type === "executeScript" && String(b.system?.source ?? "").includes("RegionHandler"));
      if (bad.length) {
        await region.deleteEmbeddedDocuments("RegionBehavior", bad.map(b => b.id));
      }
    } catch (e) { console.warn("[adm-levels] region from tile: cleanup of foreign edits failed", e); }
  };
  await fix();
  // Second pass: the Levels behavior is created deferred and may arrive later.
  await new Promise(r => setTimeout(r, 250));
  await fix();
}

async function _buildRegion(tile) {
  const gs = Number(canvas?.grid?.size) || 0;
  if (!gs || canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
    ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.regionFromTile.needGrid"));
    return;
  }
  const snap = _grabTilePixels(tile);
  if (!snap) {
    ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.regionFromTile.noImage"));
    return;
  }

  // Walk the SCENE GRID, not from the tile corner: the region must sit on cells,
  // otherwise it won't line up with movement or with neighbouring regions.
  const box = _tileBox(snap);
  const off = canvas.grid.getOffset({ x: box.x, y: box.y });
  const tl = canvas.grid.getTopLeftPoint({ i: off.i, j: off.j });
  const cols = Math.ceil((box.x + box.w - tl.x) / gs);
  const rows = Math.ceil((box.y + box.h - tl.y) / gs);
  if (cols <= 0 || rows <= 0) return;

  // Analyse ALL cells first, and only then decide the fate of bevels: a cut
  // depends on the neighbours, and they must be known in advance.
  if (globalThis.__ADM_REGION_DEBUG) globalThis.__ADM_REGION_LOG = [];
  const cls = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cls[r * cols + c] = _classifyCell(snap, tl.x + c * gs, tl.y + r * gs, gs);
    }
  }

  // ⚠️ THE BEVEL DECISION IS BY NEIGHBOURS, not by the cell itself. Measurement showed
  // that cells on a straight edge and on a diagonal have the SAME coverage (0.65–0.82) —
  // no threshold will separate them. Topology does: a diagonal has TWO adjacent
  // sides empty at once (an outer corner), a straight edge has one.
  // As a bonus this naturally forbids cuts into the contour: the neighbours there are busy.
  const REMOVED = {           // where the cut-away half faces
    tl: [[0, 1], [1, 0]],     // bottom-right removed → look right and down
    tr: [[0, -1], [1, 0]],
    br: [[0, -1], [-1, 0]],
    bl: [[0, 1], [-1, 0]],
  };
  const _cover = (r, c) => (r >= 0 && c >= 0 && r < rows && c < cols)
    ? (cls[r * cols + c]?.cover ?? 0) : 0;
  // ⚠️ A cell counts as busy when it has AT LEAST HALF of the material, not only
  // when solid. Otherwise two adjacent cells on a nearly straight edge both get cut
  // the same way, and a wedge of emptiness is left between their halves — a notch in the corner.
  // Stairs are unaffected: there the diagonal neighbours really are empty.
  const _busy = (r, c) => _cover(r, c) >= CUT_MIN_COVER;

  const full = new Uint8Array(cols * rows);
  const tris = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = cls[r * cols + c];
      const cover = v?.cover ?? 0;
      const cand = v?.cand ?? null;
      // Outer corner: both sides the cut faces are free.
      const outer = cand && (REMOVED[cand.name] ?? []).every(([dr, dc]) => !_busy(r + dr, c + dc));
      // ⚠️ Half-cell in a RUN of a straight edge. The corner is not outer, and there
      // are two or more busy side neighbours — the cell stands in a wall and must be whole.
      // Otherwise a notch appeared on a straight edge: coverage 0.50 missed the
      // half threshold by a hair (measured on a roof, cell 936,364).
      const _nb = [[0, 1], [0, -1], [1, 0], [-1, 0]]
        .reduce((n, [dr, dc]) => n + (_busy(r + dr, c + dc) ? 1 : 0), 0);
      const inRun = !outer && cover >= CUT_MIN_COVER && _nb >= 2;
      // ⚠️ A bevel on a weakly covered cell — only if it CONTINUES the edge,
      // i.e. it has two busy neighbours. This is the protection from grass and straw:
      // a stray tuft touches the body on one side only and stays empty, however
      // much it looks like a triangle (measured: 0.25 with one neighbour).
      // Recognition thresholds are kept low precisely because it is this condition
      // that filters, not they — otherwise corner tips were dropped along with the junk.
      const canCut = outer && cover >= CUT_MIN_COVER && (cover >= FULL_COVER || _nb >= 2);
      if (canCut) {
        tris.push(_triShape(cand.name, tl.x + c * gs, tl.y + r * gs, gs));
      } else if (inRun || cover >= FULL_COVER) {
        full[r * cols + c] = 1;
      }
      if (globalThis.__ADM_REGION_DEBUG && cover > 0.05 && cover < 0.97) {
        globalThis.__ADM_REGION_LOG.push({
          cell: `${Math.round(tl.x + c * gs)},${Math.round(tl.y + r * gs)}`,
          cover: +cover.toFixed(2),
          candidate: cand?.name ?? "—",
          coverShare: cand ? +cand.ofHits.toFixed(2) : 0,
          outerCorner: !!outer,
          neighbours: _nb,
          decision: canCut ? `bevel ${cand.name}`
            : (inRun ? "full (run)" : (cover >= FULL_COVER ? "full" : "empty")),
        });
      }
    }
  }

  const shapes = [..._mergeFull(full, cols, rows, tl.x, tl.y, gs), ...tris];
  if (globalThis.__ADM_REGION_DEBUG) {
    console.info("[adm-levels] region from tile:",
      "image", `${snap.iw}×${snap.ih}`,
      "| tile", `${Math.round(snap.dw)}×${Math.round(snap.dh)} @ ${Math.round(snap.dx)},${Math.round(snap.dy)}`,
      "| cells", `${cols}×${rows}`,
      "| full", full.reduce((a, v) => a + v, 0),
      "| bevels", tris.length,
      "| centre probe:", _opaqueAt(snap, snap.dx + snap.dw / 2, snap.dy + snap.dh / 2));
    const log = globalThis.__ADM_REGION_LOG ?? [];
    console.info(`[adm-levels] borderline cells: ${log.length}`);
    try { console.table(log); } catch (_e) { console.info(log); }
  }
  if (!shapes.length) {
    ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.regionFromTile.noOpaque"));
    return;
  }

  const ft = Number(tile.document?.elevation) || 0;
  // Name and colour — EXACTLY as when a plateau is created normally via the region window:
  // «15ft» and colour by elevation (see _autoRename/_autoColor in main.mjs). Fill
  // opacity there is set to 0.25 — we repeat it, otherwise the region looks different.
  const name = `${ft}ft`;
  const color = _plateauColor(ft);
  const created = await canvas.scene.createEmbeddedDocuments("Region", [{
    name,
    color,
    shapes,
    // Single-height range — as the user asked: 15 → «15–15».
    elevation: { bottom: ft, top: ft },
    visibility: CONST.REGION_VISIBILITY?.LAYER ?? 0,
    flags: {
      [MODULE_ID]: {
        [FLAG_TYPE]: "plateau",
        [FLAG_ELEVATION]: _ftToKey(ft),
        // The "this region is ours" marker — used to fend off foreign edits, see below.
        fromTile: ft,
      },
      // The same fill opacity the region window sets on save.
      tokenmagic: { regionData: { alpha: 0.25 } },
    },
  }]);
  const region = created?.[0];
  if (region) await _undoLevelsHijack(region, name, color, ft);

  const cells = full.reduce((a, v) => a + v, 0);
  ui.notifications?.info(
    game.i18n.format("ADM_LEVELS.regionFromTile.created", { ft, cells, tris: tris.length }),
  );
  return created?.[0];
}

export const TOOL = {
  id: "regionFromTile",
  name: "ADM_LEVELS.settings.regionFromTile.name",
  hint: "ADM_LEVELS.settings.regionFromTile.hint",

  onReady({ isEnabled }) {
    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled() || !game.user?.isGM) return;
      const tools = controls?.regions?.tools;
      if (!tools) return;
      tools.admRegionFromTile = {
        name: "admRegionFromTile",
        title: game.i18n.localize("ADM_LEVELS.regionFromTile.button"),
        icon: "fas fa-vector-square",
        button: true,
        onChange: async () => {
          ui.notifications?.info(game.i18n.localize("ADM_LEVELS.regionFromTile.pick"));
          const tile = await _pickTile();
          if (!tile) return;
          try { await _buildRegion(tile); }
          catch (e) {
            console.warn("[adm-levels] region from tile:", e);
            ui.notifications?.error(game.i18n.localize("ADM_LEVELS.regionFromTile.failed"));
          }
        },
      };
    });
  },
};
