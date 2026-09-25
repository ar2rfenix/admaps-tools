// scripts/tools/levels-fast-roof-fade.mjs
// ADMaps Tools sub-module: «Roofs fade fast».
//
// PROBLEM. Walking into a building takes almost a second for the roof to disappear. That is not
// the roof module nor Levels — it is core: CONFIG.Canvas.hoverFade = { delay: 250, duration: 750 }
// (delay before the start + duration of the animation itself, see
// canvas/primary/primary-occludable-object.mjs #updateHoverFadeState).
//
// SOLUTION. We set our own values. Core reads them on every frame, so the change
// applies immediately and nothing needs to be redrawn. Untick the checkbox — back to
// the factory 250/750.

const DEF_DELAY = 0;      // no delay
const DEF_DURATION = 120; // nearly instant, but without a jolt

let _orig = null;

export const TOOL = {
  id: "levelsFastRoofFade",
  name: "ADM_LEVELS.settings.levelsFastRoofFade.name",
  hint: "ADM_LEVELS.settings.levelsFastRoofFade.hint",
  settingScope: "client",   // visual speed is a personal matter

  onReady({ isEnabled }) {
    const cfg = CONFIG?.Canvas?.hoverFade;
    if (!cfg) return;
    if (!_orig) _orig = { delay: cfg.delay, duration: cfg.duration };

    const apply = () => {
      const on = isEnabled();
      // Custom values can be overridden from the console until relogin:
      //   __ADM_ROOF_FADE = { delay: 0, duration: 0 }
      const custom = globalThis.__ADM_ROOF_FADE ?? {};
      CONFIG.Canvas.hoverFade.delay = on ? (custom.delay ?? DEF_DELAY) : _orig.delay;
      CONFIG.Canvas.hoverFade.duration = on ? (custom.duration ?? DEF_DURATION) : _orig.duration;
    };

    apply();
    // Toggling the checkbox without relogin, and entering another scene.
    Hooks.on("canvasReady", apply);
    globalThis.__admApplyRoofFade = apply;
  },
};
