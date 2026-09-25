// scripts/tools/tile-fade-extra.mjs
// Shared by the ADMaps Tools sub-modules that fade a tile WHOLE on top of what core computes
// (tile-hover-link: a linked roof is hovered; tile-partial-fade: a hovered tile above a shielded roof, a hovered
// tile with «Black shadow under the tile»). Not a sub-module itself: no TOOL, no checkbox.
//
// ⚠️ libWrapper allows ONE wrapper per package per target («A wrapper for '…' has already been registered by …»):
// once partial fade wrapped PrimarySpriteMesh#updateCanvasTransform too, the hover link's registration threw and
// the link silently stopped working (24.09.2026). So the wrapper lives here, once, and the sub-modules add
// providers to it.
//
// The fade goes into the fade channel of the tile's occlusion state right after core computes it every frame
// (PrimaryCanvasGroup#update → updateCanvasTransform): the whole tile, with the provider's own easing. And the
// faded tile stops lifting the dark: Better Roofs shows a tile through the fog by its silhouette in the vision
// mask (betterroofs/scripts/helpers.js showTileThroughFog), so a faded mast kept showing the deck under it where the
// token sees nothing — instead of the shadow (24.09.2026). Its reveal sprite is dimmed by the same amount.

const MODULE_ID = "adm-levels";

/** Providers: (mesh, tile) → how much to fade the tile, 0..1. */
const _providers = new Set();
let _registered = false;
/** tileId → the alpha we gave its Better Roofs reveal sprite (only while dimmed). */
const _dimmed = new Map();

function _revealSprite(tileId) {
  const box = canvas?.masks?.vision?.children?.find((c) => c.name === "fogRoofContainer");
  return box?.children?.find((c) => c.name === tileId) ?? null;
}

/** Keep the tile's Better Roofs reveal as visible as the tile itself. The vision mask is not re-rendered by
 *  itself (CanvasVisionMask#autoRender = false) — marked dirty on every change. */
function _syncReveal(tileId, h) {
  const want = (h > 0) ? Math.max(0, 1 - h) : 1;
  const was = _dimmed.get(tileId);
  if ((was === undefined) && (want === 1)) return;
  const sprite = _revealSprite(tileId);
  if (sprite && (sprite.alpha !== want)) {
    sprite.alpha = want;
    if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
  }
  if (want === 1) _dimmed.delete(tileId);
  else _dimmed.set(tileId, want);
}

/** Add a provider; the wrapper is registered with the first one. */
export function addTileFade(provider) {
  _providers.add(provider);
  if (_registered || !globalThis.libWrapper?.register) return;
  _registered = true;
  try {
    libWrapper.register(
      MODULE_ID,
      "foundry.canvas.primary.PrimarySpriteMesh.prototype.updateCanvasTransform",
      function (wrapped, ...args) {
        const result = wrapped(...args);
        const tile = this.object;
        if (!(tile instanceof foundry.canvas.placeables.Tile) || (tile.mesh !== this)) return result;
        let h = 0;
        for (const p of _providers) {
          try { h = Math.max(h, Number(p(this, tile)) || 0); } catch (_e) {}
        }
        if (h > 0) this._occlusionState.fade = Math.max(this._occlusionState.fade, Math.min(1, h));
        _syncReveal(tile.id, h);
        return result;
      },
      "WRAPPER",
    );
  } catch (e) {
    _registered = false;
    console.warn("[adm-levels] tile fade: wrapper", e);
  }
  Hooks.on("canvasTearDown", () => _dimmed.clear());
}
