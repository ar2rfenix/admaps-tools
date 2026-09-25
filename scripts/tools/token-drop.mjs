// modules/admaps-token-drop/scripts/main.mjs
//
// ADMaps Token Drop — dragging an actor folder onto the scene with a live preview
// and wall awareness.
//
// ⚠️ The drag is NATIVE HTML5; our own mouse capture was removed. Previously the tool
// installed a native dragstart blocker already on mousedown (otherwise Chromium showed a
// folder "ghost"), and that killed the native drag for the whole gesture: the folder could
// not be dragged within the list to change its parent. Installing the blocker "later" is
// impossible — the browser decides about the drag within the first pixels, once per gesture.
//
// Hence the flow: the folder is dragged normally (inside the list it works as usual), and on
// DROP ONTO THE SCENE (dropCanvasData hook) the already existing placement mode kicks in —
// the preview follows the cursor, the wheel cycles layouts, Esc cancels, click places.
// Layout cycling thus moved from "during the drag" to "after the drop":
// during a native drag Chromium swallows wheel and keydown anyway.
//
// Placement algorithm:
//   • BFS from the drop-point center over 4-connectivity.
//   • Each candidate cell is checked via
//     CONFIG.Canvas.polygonBackends.move.testCollision — if there is a wall between the
//     drop center and the candidate center, the cell is discarded.
//   • This guarantees that all placed tokens end up in one connected
//     space (corridor / room) — nobody "behind the wall".

const MODULE_ID = "admaps-token-drop";

let _previewContainer = null;       // PIXI.Container on canvas.controls
let _state = null;                  // { folderUuid, actorIds, downX, downY, sourceEl, mode, lastPos }

// ────────────────────────────────────────────────────────────────────────────
// Geometry / walls
// ────────────────────────────────────────────────────────────────────────────

function _getDropTopLeft(clientX, clientY) {
  const transform = canvas.tokens.worldTransform;
  const tx = (clientX - transform.tx) / canvas.stage.scale.x;
  const ty = (clientY - transform.ty) / canvas.stage.scale.y;
  return canvas.grid.getTopLeftPoint({ x: tx, y: ty });
}

function _cellCenter(x, y) {
  return { x: x + canvas.grid.sizeX / 2, y: y + canvas.grid.sizeY / 2 };
}

// Is the cell (`cellX, cellY` — top-left) reachable from the point `dropCx, dropCy`?
// We test the center + 4 corners of the cell with a small inset from the edges. The inset
// is needed so we don't land exactly on a wall (testCollision right on a wall gives an
// unstable result) and so that a cell which a wall touches from the outside (rather than
// cutting into it) still passes as "reachable".
function _cellReachable(dropCx, dropCy, cellX, cellY) {
  const sx = canvas.grid.sizeX;
  const sy = canvas.grid.sizeY;
  // Inset ~10% of the cell size. For a 100×100 cell — 10px from the edge.
  const inX = sx * 0.1;
  const inY = sy * 0.1;
  const points = [
    [cellX + sx / 2,  cellY + sy / 2],        // center
    [cellX + inX,     cellY + inY],           // top-left
    [cellX + sx - inX, cellY + inY],          // top-right
    [cellX + inX,     cellY + sy - inY],      // bottom-left
    [cellX + sx - inX, cellY + sy - inY],     // bottom-right
  ];
  for (const [px, py] of points) {
    if (_wallBlocks(dropCx, dropCy, px, py)) return false;
  }
  return true;
}

function _wallBlocks(x1, y1, x2, y2) {
  try {
    const backend = CONFIG?.Canvas?.polygonBackends?.move;
    if (backend?.testCollision) {
      return backend.testCollision(
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        { type: "move", mode: "any" }
      );
    }
  } catch (e) { console.warn(`[${MODULE_ID}] wall test failed:`, e); }
  return false;
}

function _sizeOfActor(actor) {
  const w = Math.max(1, Math.ceil(Number(actor?.prototypeToken?.width)  || 1));
  const h = Math.max(1, Math.ceil(Number(actor?.prototypeToken?.height) || 1));
  return { w, h };
}

function _sizesFromIds(actorIds) {
  return (actorIds ?? []).map((id) => _sizeOfActor(game.actors?.get(id)));
}

// Effective sizes taking customSizes (override from the API) and the current orderShift into account.
function _effectiveSizes() {
  const ids = _effectiveActorIds();
  if (!ids?.length) return [];
  // customSizes is stored in the original actorIds order; apply the same shift.
  if (Array.isArray(_state?.customSizes) && _state.customSizes.length === _state.actorIds.length) {
    const shift = _currentOrderShift();
    if (shift === 0) return _state.customSizes.slice();
    return _state.customSizes.slice(shift).concat(_state.customSizes.slice(0, shift));
  }
  return _sizesFromIds(ids);
}

// Anchor — the side relative to the drop-cell where a large token "extends" to.
// 0=→ right, 1=↓ down, 2=← left, 3=↑ up. Controlled by the mouse wheel.
//
// Behavior for a w*h block:
//   • anchor=right (0): top-left = drop, the drop-cell is in the block's left column →
//     the block is to the right of the drop. Centered along the perpendicular axis (y).
//   • anchor=left  (2): top-left.x = drop.x - (w-1)*sx, the drop-cell is in the right
//     column → the block is to the left of the drop.
//   • anchor=down  (1): the drop-cell is in the top row → the block is below.
//   • anchor=up    (3): the drop-cell is in the bottom row → the block is above.
//
// For small tokens (1×1) the anchor does not change startTL — it is the drop-cell itself.
// Hence additionally: BFS dirs are chosen "opposite" to the anchor,
// so that small neighbors move away from the large one instead of climbing onto it.
const _ANCHOR_DIRS = [
  [[ 1,  0], [-1,  0], [ 0,  1], [ 0, -1]], // 0: right-first
  [[ 0,  1], [ 0, -1], [ 1,  0], [-1,  0]], // 1: down-first
  [[-1,  0], [ 1,  0], [ 0,  1], [ 0, -1]], // 2: left-first
  [[ 0, -1], [ 0,  1], [ 1,  0], [-1,  0]], // 3: up-first
];

function _startOffsetCellsFor(anchor, w, h) {
  // Returns [dx, dy] in CELLS from the drop-cell to the top-left of the start position.
  switch (anchor) {
    case 1: return [-Math.floor((w - 1) / 2), 0];               // down
    case 2: return [-(w - 1), -Math.floor((h - 1) / 2)];        // left
    case 3: return [-Math.floor((w - 1) / 2), -(h - 1)];        // up
    case 0:
    default: return [0, -Math.floor((h - 1) / 2)];              // right
  }
}

// Finds top-left positions for tokens of arbitrary size. For each
// `sizes[i] = { w, h }` it finds a w*h block of cells that:
//   • does not overlap already occupied cells (of previous tokens),
//   • is not walled off from the drop-cell center.
// The start position and the BFS neighbor order depend on the anchor — this gives
// the user wheel control over "which direction the large tokens extend to".
function _findSpots(centerX, centerY, sizes, anchor = 0) {
  const sx = canvas.grid.sizeX;
  const sy = canvas.grid.sizeY;
  if (!sx || !sy || !sizes?.length) return [];
  const dropCenter = _cellCenter(centerX, centerY);
  const occupied = new Set();
  const result = [];
  // Small neighbors go in the direction opposite to the anchor (away from the large one).
  const dirs = (_ANCHOR_DIRS[(anchor + 2) % 4] ?? _ANCHOR_DIRS[2])
    .map(([dx, dy]) => [dx * sx, dy * sy]);

  for (const { w, h } of sizes) {
    const [offCellsX, offCellsY] = _startOffsetCellsFor(anchor, w, h);
    const startTLx = centerX + offCellsX * sx;
    const startTLy = centerY + offCellsY * sy;

    const visited = new Set();
    const queue = [[startTLx, startTLy]];
    let found = null;
    const SAFETY = Math.max(500, 100 * w * h);
    let scanned = 0;

    while (queue.length && !found && scanned < SAFETY) {
      scanned++;
      const [x, y] = queue.shift();
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      visited.add(key);

      // Check: is the whole w*h block of cells free?
      const blockCells = [];
      let blockFree = true;
      for (let i = 0; i < w && blockFree; i++) {
        for (let j = 0; j < h; j++) {
          const cx = x + i * sx;
          const cy = y + j * sy;
          if (occupied.has(`${cx},${cy}`)) { blockFree = false; break; }
          blockCells.push([cx, cy]);
        }
      }
      if (blockFree) {
        // Wall check: EVERY sub-cell of the block must be fully reachable
        // from the drop (center + 4 corners with inset). Testing only the center missed
        // the case "a wall cuts the cell in half, the center is visible" — and the token
        // was placed halfway inside the wall.
        let wallOk = true;
        for (const [cx, cy] of blockCells) {
          if (!_cellReachable(dropCenter.x, dropCenter.y, cx, cy)) {
            wallOk = false;
            break;
          }
        }
        if (wallOk) {
          found = [x, y];
          for (const [cx, cy] of blockCells) occupied.add(`${cx},${cy}`);
        }
      }
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (!visited.has(`${nx},${ny}`)) queue.push([nx, ny]);
      }
    }

    if (found) {
      result.push(found);
    } else {
      // Fallback — no spot found (everything occupied / walled off): put it at the start
      // position. It may overlap, but that's better than losing the placement.
      result.push([startTLx, startTLy]);
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) {
          occupied.add(`${startTLx + i * sx},${startTLy + j * sy}`);
        }
      }
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Preview (PIXI overlay)
// ────────────────────────────────────────────────────────────────────────────

function _ensurePreviewContainer() {
  if (_previewContainer && !_previewContainer.destroyed) return _previewContainer;
  const PIXI = globalThis.PIXI;
  if (!PIXI || !canvas?.controls) return null;
  _previewContainer = new PIXI.Container();
  canvas.controls.addChild(_previewContainer);
  return _previewContainer;
}

// Returns the color of the actor's player owner (non-GM). If there is none —
// returns null (the caller substitutes a default). The color is taken from
// Foundry User.color and normalized to a number (0xRRGGBB).
function _ownerColorOf(actor) {
  if (!actor || !game.users) return null;
  for (const u of game.users) {
    if (u.isGM) continue;
    try {
      if (actor.testUserPermission(u, "OWNER")) {
        const c = u.color;
        if (c == null) continue;
        // Foundry Color object → .valueOf() → number; or a "#rrggbb" string.
        if (typeof c === "number") return c;
        if (typeof c?.valueOf === "function") {
          const v = c.valueOf();
          if (typeof v === "number") return v;
        }
        if (typeof c === "string" && c.startsWith("#")) {
          return parseInt(c.slice(1), 16);
        }
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

const _DEFAULT_TILE_COLOR = 0x00ff66;

// Token border colors by disposition — standard Foundry values.
// Used as a fallback when the actor has no player owner.
const _DISPOSITION_COLORS = {
  [-2]: 0x550000, // SECRET (HIDDEN)
  [-1]: 0xe72124, // HOSTILE
   [0]: 0xf1d836, // NEUTRAL
   [1]: 0x33bc4e, // FRIENDLY
};

function _dispositionColorOf(actor) {
  if (!actor) return null;
  const d = actor.prototypeToken?.disposition;
  if (d == null) return null;
  return _DISPOSITION_COLORS[d] ?? null;
}

function _drawPreview(spots, actorIds, sizes) {
  const container = _ensurePreviewContainer();
  if (!container) return;
  const PIXI = globalThis.PIXI;
  while (container.children.length) {
    const c = container.removeChildAt(0);
    try { c.destroy?.({ children: true }); } catch (_) {}
  }
  const sx = canvas.grid.sizeX;
  const sy = canvas.grid.sizeY;
  for (let i = 0; i < spots.length; i++) {
    const [x, y] = spots[i];
    const actorId = actorIds?.[i];
    const actor = actorId ? game.actors?.get(actorId) : null;
    // size either from the override (customSizes) or from the actor's prototypeToken.
    const { w, h } = sizes?.[i] ?? _sizeOfActor(actor);
    const cellW = w * sx;
    const cellH = h * sy;
    // Border color: priority — the owner's color (if the actor belongs to a player),
    // fallback — the prototype token's disposition color (like Foundry's native border),
    // last fallback — our default green.
    const color = _ownerColorOf(actor)
                ?? _dispositionColorOf(actor)
                ?? _DEFAULT_TILE_COLOR;
    // 1) Background fill UNDER the sprite — visible at the edges if scale<1 or there is an offset.
    const fillGfx = new PIXI.Graphics();
    fillGfx.beginFill(color, 0.22);
    fillGfx.drawRect(x, y, cellW, cellH);
    fillGfx.endFill();
    container.addChild(fillGfx);
    // 2) The actor's sprite icon. Foundry draws the texture over the WHOLE cell bounding box
    // (cellW × cellH), and scale/offset are applied on top. No -4px insets
    // (that was the bug — the preview looked smaller than the real token).
    if (actor) {
      const tex = actor.prototypeToken?.texture ?? {};
      const texSrc = tex.src || actor.img;
      if (texSrc) {
        try {
          const sprite = PIXI.Sprite.from(texSrc);
          const sX = Number(tex.scaleX) || 1;
          const sY = Number(tex.scaleY) || 1;
          const oX = Number(tex.offsetX) || 0;
          const oY = Number(tex.offsetY) || 0;
          const finalW = cellW * sX;
          const finalH = cellH * sY;
          const cx = x + cellW / 2 + oX;
          const cy = y + cellH / 2 + oY;
          // Via anchor=0.5 + center position: works correctly with rotation.
          sprite.anchor?.set?.(0.5);
          sprite.x = cx;
          sprite.y = cy;
          sprite.width = finalW;
          sprite.height = finalH;
          // Tint: a number (0xRRGGBB), a "#rrggbb" string or a Color object.
          const t = tex.tint;
          if (typeof t === "number") sprite.tint = t;
          else if (typeof t === "string" && t.startsWith("#")) {
            sprite.tint = parseInt(t.slice(1), 16);
          } else if (t && typeof t.valueOf === "function") {
            const tv = t.valueOf();
            if (typeof tv === "number") sprite.tint = tv;
          }
          // Prototype token rotation (rotation in degrees → radians).
          const rot = Number(actor.prototypeToken?.rotation) || 0;
          if (rot) sprite.rotation = (rot * Math.PI) / 180;
          container.addChild(sprite);
        } catch (_) { /* texture load fail — skip */ }
      }
    }
    // 3) Border ON TOP of the sprite — otherwise the sprite (full block size) covers it.
    // The +1 / -2 shift — so the 2px line runs inside the block instead of sticking out past the edge.
    const borderGfx = new PIXI.Graphics();
    borderGfx.lineStyle(2, color, 0.95);
    borderGfx.drawRect(x + 1, y + 1, cellW - 2, cellH - 2);
    container.addChild(borderGfx);
  }
}

function _clearPreview() {
  if (_previewContainer && !_previewContainer.destroyed) {
    while (_previewContainer.children.length) {
      const c = _previewContainer.removeChildAt(0);
      try { c.destroy?.({ children: true }); } catch (_) {}
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// State helpers
// ────────────────────────────────────────────────────────────────────────────

function _isOverCanvas(clientX, clientY) {
  const board = document.getElementById("board");
  if (!board) return false;
  const rect = board.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top  && clientY <= rect.bottom;
}

// Derived from state.tick:
//   anchor      = tick mod 4 — the placement side of the large one.
//   orderShift  = tick mod N — the actor order shift.
// Each wheel click changes BOTH parameters at once — otherwise with
// orderShift=const the "first" actor (the one landing in the drop-cell) stays
// under the cursor for all 4 anchor positions, and the user sees that
// a particular portrait is "glued" to the cursor.
function _currentAnchor() {
  const t = _state?.tick ?? 0;
  return ((t % 4) + 4) % 4;
}

function _currentOrderShift() {
  const n = _state?.actorIds?.length || 0;
  if (n <= 1) return 0;
  const t = _state?.tick ?? 0;
  return ((t % n) + n) % n;
}

function _effectiveActorIds() {
  const ids = _state?.actorIds;
  if (!ids?.length) return [];
  const s = _currentOrderShift();
  if (s === 0) return ids;
  return ids.slice(s).concat(ids.slice(0, s));
}

function _redrawAtLastPos() {
  if (!_state?.lastPos || !canvas?.ready) return;
  const ids = _effectiveActorIds();
  const sizes = _effectiveSizes();
  const spots = _findSpots(
    _state.lastPos.x, _state.lastPos.y,
    sizes,
    _currentAnchor(),
  );
  _drawPreview(spots, ids, sizes);
}

function _stepTick(dir) {
  if (!_state) return;
  _state.tick = (_state.tick ?? 0) + (dir > 0 ? 1 : -1);
  _redrawAtLastPos();
}

// ────────────────────────────────────────────────────────────────────────────
// Event handlers
// ────────────────────────────────────────────────────────────────────────────

// Extracts the actorId list from the draggable source. We support ONLY actor
// folders — for single actor rows we leave the native Foundry flow (HTML5
// drag → dropCanvasData → token).
/** Actor ids of the FOLDER (without nested ones — as it was in the drag version). */
function _folderActorIds(folder) {
  if (folder?.type !== "Actor") return null;
  const ids = (folder.contents ?? []).map((a) => a.id).filter(Boolean);
  return ids.length ? ids : null;
}

function _onPointerDown(event) {
  if (event.button !== 0) return;        // LMB only
  // The handler's only job is to confirm the placement with a click on the scene.
  // ⚠️ Intercepting the drag from the list is NO LONGER done here: it installed a blocker
  // of the native HTML5 drag already on mousedown, and the folder could not be dragged
  // within the list (e.g. to change its parent). Now we use the native drag, and our mode
  // is enabled only when the folder is dropped ONTO THE SCENE — see the dropCanvasData hook in onReady.
  if (_state?.mode !== "placement") return;
  if (!_isOverCanvas(event.clientX, event.clientY)) return;
  event.preventDefault();
  event.stopPropagation();
  _finishPlacement(event);
}

function _onPointerMove(event) {
  if (!_state) return;
  if (_state.mode !== "placement") return;
  if (!canvas?.ready) return;
  // Preview only while the cursor is over the canvas.
  if (!_isOverCanvas(event.clientX, event.clientY)) {
    _clearPreview();
    _state.lastPos = null;
    return;
  }
  const { x, y } = _getDropTopLeft(event.clientX, event.clientY);
  _state.lastPos = { x, y };
  const ids = _effectiveActorIds();
  const sizes = _effectiveSizes();
  const spots = _findSpots(x, y, sizes, _currentAnchor());
  _drawPreview(spots, ids, sizes);
}

async function _finishPlacement(event) {
  if (!_state || _state.mode !== "placement" || !canvas?.scene) return;
  const { x, y } = _getDropTopLeft(event.clientX, event.clientY);
  const ids = _effectiveActorIds();
  const sizes = _effectiveSizes();
  const spots = _findSpots(x, y, sizes, _currentAnchor());
  const hidden = !!event.altKey || !!_state.placementHidden;
  // noSpawn mode (called from a third-party module): return the coordinates,
  // the caller decides what to do with them.
  if (_state.noSpawn) {
    _resolveActiveCallback({
      cancelled: false,
      spots, actorIds: ids.slice(), sizes: sizes.slice(), hidden,
    });
    _cleanup();
    return;
  }
  const tokens = await _spawnTokensCore(ids, spots, hidden);
  _resolveActiveCallback({ cancelled: false, tokens });
  _cleanup();
}

function _resolveActiveCallback(payload) {
  if (!_state) return;
  const resolve = _state.resolve;
  _state.resolve = null;
  if (typeof resolve === "function") {
    try { resolve(payload); } catch (e) { console.warn(`[${MODULE_ID}] resolve threw:`, e); }
  }
}

function _onKeyDown(event) {
  if (!_state) return;
  if (_state.mode !== "active" && _state.mode !== "placement") return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    _cleanup();
  }
}

function _onWheel(event) {
  if (!_state) return;
  if (_state.mode !== "active" && _state.mode !== "placement") return;
  event.preventDefault();
  event.stopPropagation();
  // The wheel increments tick: each step is the next unique layout
  // (a combination of anchor + order shift of the small ones).
  _stepTick((event.deltaY || 0) > 0 ? 1 : -1);
}

async function _spawnTokensCore(actorIds, spots, isHidden) {
  const sources = [];
  for (let i = 0; i < actorIds.length; i++) {
    const actor = game.actors?.get(actorIds[i]);
    if (!actor) continue;
    const spot = spots[i] || spots[spots.length - 1];
    if (!spot) continue;
    try {
      const tokenDoc = await actor.getTokenDocument({
        x: spot[0],
        y: spot[1],
        hidden: isHidden,
      });
      sources.push(tokenDoc.toObject());
    } catch (e) {
      console.warn(`[${MODULE_ID}] getTokenDocument failed for ${actor.name}:`, e);
    }
  }
  if (!sources.length) return [];
  try {
    const created = await canvas.scene.createEmbeddedDocuments("Token", sources);
    return Array.isArray(created) ? created : [];
  } catch (e) {
    console.error(`[${MODULE_ID}] createEmbeddedDocuments failed:`, e);
    return [];
  }
}

function _cleanup() {
  // If the placement session closes without a spawn (Escape / API.cancel) —
  // resolve with a cancelled callback.
  _resolveActiveCallback({ cancelled: true, tokens: [] });
  _state = null;
  _clearPreview();
  document.body.style.cursor = "";
  document.removeEventListener("pointermove", _onPointerMove, true);
  document.removeEventListener("wheel",       _onWheel,       { capture: true });
  document.removeEventListener("keydown",     _onKeyDown,     true);
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────
//
// Access:
//   const api = game.modules.get("admaps-token-drop")?.api;
//   const { cancelled, tokens } = await api.startPlacement({ actorIds });
//
// Listen for module readiness (if the code may run earlier):
//   Hooks.on("admapsTokenDrop:ready", (api) => { ... });

/**
 * Starts the interactive placement mode for an arbitrary list of actors.
 * The cursor becomes a crosshair, a live preview with walls-aware BFS is drawn
 * under the cursor, wheel/arrows cycle the order, Escape cancels, LMB on the scene —
 * spawns the tokens and resolves the Promise.
 *
 * @param {object}   opts
 * @param {string[]} opts.actorIds — actor ids (game.actors).
 * @param {Array<{w:number,h:number}>} [opts.sizes] — size override (by default
 *   taken from each actor's prototypeToken). Length must match actorIds.
 * @param {boolean}  [opts.hidden] — spawn hidden (like a drag with Alt).
 * @param {boolean}  [opts.noSpawn] — do NOT create tokens, return only the coordinates.
 *   Useful when the caller wants to do the spawn itself (e.g. with a tier-delta).
 * @returns {Promise<{
 *   cancelled: boolean,
 *   tokens?:   TokenDocument[],          // only if !noSpawn
 *   spots?:    Array<[number, number]>,  // only if noSpawn — top-left per token
 *   actorIds?: string[],                 // only if noSpawn — final order
 *   sizes?:    Array<{w,h}>,             // only if noSpawn — matching the order
 *   hidden?:   boolean,                  // only if noSpawn — Alt at drop
 * }>}
 */
function admStartPlacement({ actorIds, sizes, hidden = false, noSpawn = false } = {}) {
  return new Promise((resolve) => {
    if (!game.user?.isGM) { resolve({ cancelled: true, tokens: [] }); return; }
    if (!canvas?.ready || !canvas?.scene) {
      ui.notifications?.warn?.(`${MODULE_ID}: canvas is not ready`);
      resolve({ cancelled: true, tokens: [] });
      return;
    }
    if (_state) {
      ui.notifications?.warn?.(`${MODULE_ID}: another placement is already in progress`);
      resolve({ cancelled: true, tokens: [] });
      return;
    }
    // Filter actorIds, keeping only those existing in game.actors. In parallel
    // filter sizes (if given) — the indices must correspond.
    const ids = [];
    const customSizes = Array.isArray(sizes) ? [] : null;
    const inputIds = actorIds ?? [];
    for (let i = 0; i < inputIds.length; i++) {
      const id = inputIds[i];
      if (!game.actors?.get(id)) continue;
      ids.push(id);
      if (customSizes) {
        const s = sizes[i] || {};
        customSizes.push({
          w: Math.max(1, Math.ceil(Number(s.w) || 1)),
          h: Math.max(1, Math.ceil(Number(s.h) || 1)),
        });
      }
    }
    if (!ids.length) { resolve({ cancelled: true, tokens: [] }); return; }

    _state = {
      folderUuid: null,
      actorIds: ids,
      customSizes,                   // null = derive from prototypeToken
      noSpawn: !!noSpawn,
      downX: 0, downY: 0,
      sourceEl: null,
      mode: "placement",
      lastPos: null,
      tick: 0,
      placementHidden: !!hidden,
      resolve,
    };
    document.addEventListener("pointermove", _onPointerMove, true);
    document.addEventListener("wheel",       _onWheel,       { capture: true, passive: false });
    document.addEventListener("keydown",     _onKeyDown,     true);
    document.body.style.cursor = "crosshair";
  });
}

/**
 * No UI: spawns N tokens from the point (x, y) with walls-aware arrangement.
 * @returns {Promise<TokenDocument[]>}
 */
async function admSpawnTokensAt({ actorIds, x, y, hidden = false } = {}) {
  if (!game.user?.isGM) return [];
  if (!canvas?.ready || !canvas?.scene) return [];
  const ids = (actorIds ?? []).filter((id) => game.actors?.get(id));
  if (!ids.length) return [];
  // Snap x/y to the top-left of the nearest cell.
  const tl = canvas.grid.getTopLeftPoint({ x, y });
  const spots = _findSpots(tl.x, tl.y, _sizesFromIds(ids));
  return _spawnTokensCore(ids, spots, !!hidden);
}

/**
 * Utility: computes placement points from the point (x, y) taking walls and sizes into account.
 * Returns an array of `[topLeftX, topLeftY]` (one per token).
 *
 * @param {object} opts
 * @param {number} opts.x — x in scene coordinates.
 * @param {number} opts.y — y in scene coordinates.
 * @param {Array<{w:number,h:number}>} [opts.sizes] — token sizes in cells.
 * @param {number} [opts.count] — if `sizes` is not given, treated as 1×1 × count.
 */
function admFindSpots({ x, y, sizes, count } = {}) {
  if (!canvas?.ready) return [];
  const tl = canvas.grid.getTopLeftPoint({ x, y });
  let arr = sizes;
  if (!Array.isArray(arr)) {
    const n = Math.max(0, count|0);
    arr = Array.from({ length: n }, () => ({ w: 1, h: 1 }));
  }
  return _findSpots(tl.x, tl.y, arr);
}

/** Cancel the active placement session (if any). */
function admCancel() {
  if (_state) _cleanup();
}

/** Is a session (drag or placement) currently active. */
function admIsActive() {
  return !!_state;
}

const _PUBLIC_API = Object.freeze({
  startPlacement: admStartPlacement,
  spawnTokensAt:  admSpawnTokensAt,
  findSpots:      admFindSpots,
  cancel:         admCancel,
  isActive:       admIsActive,
});

// ────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ────────────────────────────────────────────────────────────────────────────

export const TOOL = {
  id: "tokenDrop",
  name: "ADM_LEVELS.settings.tokenDrop.name",
  hint: "ADM_LEVELS.settings.tokenDrop.hint",
  replaces: ["admaps-token-drop"],

  onReady({ isEnabled, moduleId }) {
    // The API is attached under the ADMaps Tools module namespace: game.modules.get("adm-levels").api.tokenDrop.
    // (The old external contract game.modules.get("admaps-token-drop").api is dead, nobody read it.)
    try { const mod = game.modules?.get(moduleId); if (mod) (mod.api ??= {}).tokenDrop = _PUBLIC_API; } catch (_) {}
    if (!game.user?.isGM) return; // only the GM creates tokens
    // A click on the scene confirms the placement. ⚠️ No isEnabled gate: the handler now
    // serves ONLY an active placement (without _state it exits immediately), and a session
    // started via the API with the checkbox off would otherwise be impossible to confirm.
    document.addEventListener("pointerdown", _onPointerDown, true);

    // Dropping a FOLDER onto the scene → placement mode. The core does not handle folders
    // itself (board.mjs #onDrop: the switch on data.type has no "Folder" branch), so there is
    // no conflict with the default; we return false so that other handlers don't fire.
    // ⚠️ Alt at DROP = create hidden — the previous behavior is preserved: the core passes
    // the DragEvent itself to the hook as the third argument.
    Hooks.on("dropCanvasData", (_canvas, data, event) => {
      if (!isEnabled() || !game.user?.isGM) return;
      if (String(data?.type ?? "") !== "Folder") return;
      let folder = null;
      try { folder = fromUuidSync(data.uuid); } catch (_) { folder = null; }
      folder ??= game.folders?.get(data.id ?? data._id);
      const ids = _folderActorIds(folder);
      if (!ids?.length) return;                 // not an actor folder (or empty) — not our business
      admStartPlacement({ actorIds: ids, hidden: !!event?.altKey });
      return false;
    });
  },
};
