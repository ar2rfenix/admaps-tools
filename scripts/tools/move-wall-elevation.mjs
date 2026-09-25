// modules/adm-levels/scripts/tools/move-wall-elevation.mjs
// ADMaps Tools — «Walls during movement use waypoint elevation».
//
// Symptom: a path from the ground onto a plateau via stairs is found, but after release the token
// stops on the top step next to the plateau wall and goes no further.
//
// Mechanism (three links):
//   1. During a move the core (Token#constrainMovementPath → #testWallCollision) tests each
//      segment, passing the start point WITH ELEVATION — `origin.elevation`. That elevation was
//      assigned to the path waypoints earlier by adm-levels (createTerrainMovementPath wrapper): the top
//      step — 15.
//   2. wall-height (`setSourceElevation`, ClockwiseSweepPolygon#initialize wrapper) for
//      type "move" and a Token object does NOT read that elevation: it takes `document.elevation` — where
//      the token stood AT THE START of the move (0). The 0–15 plateau wall is impassable for it on the step.
//   3. wall-height itself does honor `origin.b/t` and `config.b/t` when they are set.
//
// So we do not patch wall-height (third-party module) but feed it the elevation ourselves: for a token move
// we put the span "waypoint elevation … waypoint elevation + height" into config.b/t. Height = losHeight − elevation.
// We also duplicate onto object.b/t — libWrapper wrapper order is not guaranteed, and wall-height
// rewrites them from origin/config: if it ran before us, the result is still ours.
// A point without elevation or one that already has b/t (pathfinding probes set them themselves) — left alone.

const MODULE_ID = "adm-levels";

function _fixMoveSpan(origin, config) {
  if (config?.type !== "move") return;
  if (!origin || origin.b != null || origin.t != null) return;
  const elev = origin.elevation;
  if (!Number.isFinite(elev)) return;
  const object = config.source?.object ?? origin.object;
  if (!(object instanceof foundry.canvas.placeables.Token)) return;
  const docElev = Number(object.document?.elevation ?? 0) || 0;
  const losDiff = Math.max(0, (Number(object.losHeight ?? docElev) || docElev) - docElev);
  const b = elev;
  const t = elev + losDiff;
  config.b = b;
  config.t = t;
  object.b = b;
  object.t = t;
}

export const TOOL = {
  id: "moveWallElevation",
  name: "ADM_LEVELS.settings.moveWallElevation.name",
  hint: "ADM_LEVELS.settings.moveWallElevation.hint",

  onReady({ isEnabled }) {
    if (!game.modules.get("wall-height")?.active) return;   // without wall-height walls have no elevation
    if (!globalThis.libWrapper?.register) {
      console.warn("[adm-levels] move-wall-elevation: libWrapper missing — fix not installed.");
      return;
    }
    try {
      libWrapper.register(
        MODULE_ID,
        "foundry.canvas.geometry.ClockwiseSweepPolygon.prototype.initialize",
        function (wrapped, origin, config = {}, ...rest) {
          if (isEnabled()) {
            try { _fixMoveSpan(origin, config); } catch (e) { /* the stock check matters more */ }
          }
          return wrapped(origin, config, ...rest);
        },
        "WRAPPER",
      );
    } catch (e) { console.warn("[adm-levels] move-wall-elevation: wrapper failed", e); }
  },
};
