// scripts/tools/roof-fog-fix.mjs
// ADMaps Tools sub-module: «Roof fog fix». Integrated from the adm-roof-fog-fix module.
//
// Better Roofs blends the roof sprite into the vision mask (canvas.masks.vision) and recomputes
// it on sightRefresh. When a token exits from under a roof and STOPS, there is no final vision
// recompute at the new position → the black fog zone stays stale until the next step.
// Cure: after the token stops, force one vision+occlusion recompute.
//
// Descriptor { id, name, hint, onReady } — the registry (tools/index.mjs) creates the settings checkbox itself.

export const TOOL = {
  id: "roofFogFix",
  name: "ADM_LEVELS.settings.roofFogFix.name",
  hint: "ADM_LEVELS.settings.roofFogFix.hint",
  replaces: ["adm-roof-fog-fix"],

  onReady({ isEnabled }) {
    if (!game.modules.get("betterroofs")?.active) return; // without Better Roofs the fix is not needed
    const refreshSoon = foundry.utils.debounce(() => {
      // Check the checkbox on EVERY call → toggling takes effect without a reload.
      if (!isEnabled()) return;
      if (!canvas?.ready) return;
      // only if the scene actually has Better Roofs roofs
      const hasRoof = canvas.tiles?.placeables?.some((t) => {
        const m = t.document.getFlag("betterroofs", "brMode");
        return m && m !== 0;
      });
      if (!hasRoof) return;
      canvas.perception.update({ refreshVision: true, refreshOcclusion: true });
    }, 150);
    // refreshToken fires on every frame of the movement animation; the debounce triggers
    // once, 150 ms AFTER the token stops.
    Hooks.on("refreshToken", () => refreshSoon());
  },
};
