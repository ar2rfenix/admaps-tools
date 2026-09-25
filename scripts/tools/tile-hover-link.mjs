// scripts/tools/tile-hover-link.mjs
// ADMaps Tools sub-module: «Better Roofs link on hover».
//
// PROBLEM. Better Roofs links tiles by «Occlusion Link Id»: while the link SOURCE is occluded — a token under it —
// every other tile with the same id fades with it (betterroofs/scripts/occlusionlink.js wraps
// CanvasOcclusionMask#_identifyOccludedObjects: the occluded set only). Pointing the mouse at a roof is not
// occlusion: core fades a hovered roof through its own hover state (PrimaryOccludableObjectMixin
// #updateHoverFadeState → _hoverFadeState.occlusion), so the link stayed silent and the foremast hung over the
// view into the forecastle (23.09.2026, Modular_Ship_Pack).
//
// SOLUTION. The same ids: while a source is hover-faded, every other tile with its id fades whole by the same
// amount — the fade channel of its occlusion state, raised right after core computes it every frame
// (PrimaryCanvasGroup#update → updateCanvasTransform), so the mast goes with the roof's own easing.

import { addTileFade } from "./tile-fade-extra.mjs";

const BR = "betterroofs";

/** tileId → ids of the source tiles it follows; rebuilt when tiles change. */
let _links = new Map();

function _linkId(doc) {
  return String(doc?.flags?.[BR]?.occlusionLinkId ?? "").trim();
}

function _rebuild() {
  const next = new Map();
  const tiles = canvas?.tiles?.placeables ?? [];
  const sources = new Map(); // link id → source tile ids
  for (const t of tiles) {
    const id = _linkId(t.document);
    if (!id || !t.document.flags?.[BR]?.occlusionLinkSource) continue;
    if (!sources.has(id)) sources.set(id, []);
    sources.get(id).push(t.id);
  }
  for (const t of tiles) {
    const src = (sources.get(_linkId(t.document)) ?? []).filter((id) => id !== t.id);
    if (src.length) next.set(t.id, src);
  }
  _links = next;
}

export const TOOL = {
  id: "tileHoverLink",
  name: "ADM_LEVELS.settings.tileHoverLink.name",
  hint: "ADM_LEVELS.settings.tileHoverLink.hint",

  onReady({ isEnabled }) {
    if (!game.modules.get(BR)?.active) return; // the ids and their fields come from Better Roofs

    // Through the shared wrapper (tile-fade-extra.mjs): one per package per method is all libWrapper allows.
    addTileFade((mesh, tile) => {
      if (!_links.size || !isEnabled()) return 0;
      const src = _links.get(tile.id);
      if (!src) return 0;
      // As in Better Roofs' own link (occlusionlink.js): a tile at or below the viewer's level is their floor and
      // never follows. The foremast was a link source too: hovering it faded the forecastle roof under Ivy's feet
      // (24.09.2026).
      const viewer = CONFIG.Levels?.currentToken ?? canvas.tokens?.controlled?.[0];
      const eye = Number(viewer?.document?.elevation);
      if (Number.isFinite(eye) && (eye >= (Number(tile.document.elevation) || 0))) return 0;
      let h = 0;
      for (const id of src) {
        const m = canvas.tiles?.get(id)?.mesh;
        if (!m || m.destroyed || !m.hoverFade) continue;
        h = Math.max(h, Number(m._hoverFadeState?.occlusion) || 0);
      }
      return h;
    });

    const rebuild = () => { try { _rebuild(); } catch (e) { console.warn("[adm-levels] hover link", e); } };
    Hooks.on("canvasReady", rebuild);
    Hooks.on("createTile", rebuild);
    Hooks.on("updateTile", rebuild);
    Hooks.on("deleteTile", rebuild);
    Hooks.on("canvasTearDown", () => { _links = new Map(); });
  },
};
