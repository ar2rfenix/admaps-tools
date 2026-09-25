// scripts/tools/door-mesh-elevation.mjs
// ADMaps Tools sub-module: "Door leaf below the roof".
//
// PROBLEM. If a door has a "Texture" set (leaf animation), core draws the leaf as a
// separate `DoorMesh` sprite in `canvas.primary` — right where tiles live — and takes
// its elevation like this (foundry.mjs, DoorMesh#getClosedPosition):
//
//   // TODO Unsupported except using a temporary core flag. Eventually elevation
//   // will become part of the Wall data model
//   const elevation = this.object.document?.getFlag("core", "elevation")
//                     ?? (canvas.scene.foregroundElevation - 1);
//
// A wall has no elevation field of its own, so by default the leaf ends up right under
// the foreground: with the typical `foregroundElevation: 999` that is 998 — above any roof.
// Result: a ground-floor door is visible THROUGH the roof.
//
// ⚠️ `wall-height` has nothing to do with it: it handles vision and movement, not draw
// order. Order in `canvas.primary` is elevation, then sortLayer, then sort.
//
// SOLUTION. Set the leaf's elevation to the TOP of its floor (`wall-height.top`, otherwise
// the top of the Levels scene floor found by the door's bottom).
//
// ⚠️ Why the top, not the bottom. The leaf has `sort = -Infinity` (core does not let a
// wall set sort), while the scene background sits at elevation 0 with sort 0. Had we used
// the bottom (0), the leaf would go UNDER the background and vanish entirely. The floor top
// is safe: a tie with a roof at the same elevation breaks by sortLayer (tiles 500 vs our
// SCENE 0), so the roof is always on top, and the background and tiles of its floor below.
//
// ⚠️ We write nothing to the scene. A `core.elevation` flag would have to be set on every
// door of every map, would drift when copying and would need cleanup when the checkbox is
// turned off. We patch the already created sprite — user data is untouched, the checkbox
// works on the fly, and foreign `core.elevation` flags (if someone set one manually)
// keep priority over our calculation.

const MODULE_ID = "adm-levels";
const LEVELS_ID = "levels";
const SETTING_KEY = `${MODULE_ID}.tool.doorMeshElevation`;

/* -------------------------------------------- */
/*  Elevation calculation                       */
/* -------------------------------------------- */

/** Number from an elevation field. NaN if the field is NOT SET.
 *  ⚠️ Must be this way: Foundry stores an empty elevation field as `null`, and `Number(null)` is 0.
 *  With a bare `Number()` a door with an empty "top" would get floor 0 and slide under the
 *  scene background instead of asking the Levels panel for its floor. */
function _whNum(v) {
  if (v === null || v === undefined || v === "") return NaN;
  return Number(v);
}

/** Top of the floor the door stands on. null — could not be determined. */
function _floorTop(doc) {
  const wh = doc?.flags?.["wall-height"] ?? {};

  // Common case: the door has a ceiling set — which is also the roof elevation of its floor.
  const top = _whNum(wh.top);
  if (Number.isFinite(top)) return top;

  // No ceiling (null = "to infinity"), but there is a floor — look up the scene floor by it.
  const bottom = _whNum(wh.bottom);
  if (!Number.isFinite(bottom)) return null;
  const levels = canvas?.scene?.getFlag?.(LEVELS_ID, "sceneLevels");
  if (!Array.isArray(levels)) return null;
  for (const l of levels) {
    const b = parseFloat(l?.[0]);
    const t = parseFloat(l?.[1]);
    if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
    // Top is exclusive: a door exactly on the 0–15 / 15–30 seam belongs to the UPPER floor.
    if (bottom >= b && bottom < t) return t;
  }
  return null;
}

/** Elevation core would give the leaf (without us). */
function _coreElevation(doc) {
  const own = doc?.getFlag?.("core", "elevation");
  if (own != null) return own;
  const fg = Number(canvas?.scene?.foregroundElevation);
  return (Number.isFinite(fg) ? fg : 0) - 1;
}

/**
 * Fix the elevation of a single leaf.
 * Checkbox off or floor not recognized → restore exactly what core would have given.
 */
function _fixMesh(mesh, isEnabled) {
  const doc = mesh?.object?.document;
  if (!doc || !mesh._closedPosition) return;

  // ⚠️ A manually set `core.elevation` is the scene owner's choice — we don't argue.
  const manual = doc.getFlag?.("core", "elevation") != null;
  let want = (isEnabled() && !manual) ? _floorTop(doc) : null;

  // ⚠️ Zero and below won't do: the scene background sits exactly at 0, and the leaf has
  // sort = -Infinity (cannot be set from wall data), so at zero the door goes UNDER the
  // background and vanishes completely. Treat such a floor as unrecognized and hand the door
  // back to core — better showing through the roof than gone. Basements: ceiling 0 or floor −10…0.
  if (want != null && !(want > 0)) want = null;

  const next = (want == null) ? _coreElevation(doc) : want;

  const prev = mesh._closedPosition.elevation;
  if (prev === next) return;
  mesh._closedPosition.elevation = next;
  if (mesh._animatedPosition) mesh._animatedPosition.elevation = next;

  // ⚠️ Change the live elevation only if the sprite is "at rest" — its elevation matches
  // the closed position. For the "Descend" type, core deliberately puts the leaf at
  // elevation 0 with sort = Infinity once opening COMPLETES (DoorMesh.postAnimateDescend)
  // and keeps it there until the door starts closing. Must not override that: an open door
  // would float above the floor. On close it picks up our `_closedPosition`.
  if (mesh.elevation === prev) mesh.elevation = next;
}

/** Walk every leaf on the scene (after canvas load, a wall edit, a checkbox change). */
function _sweep(isEnabled) {
  try {
    for (const wall of (canvas?.walls?.placeables ?? [])) {
      for (const mesh of (wall?.doorMeshes ?? [])) _fixMesh(mesh, isEnabled);
    }
  } catch (e) { console.warn("[adm-levels] door leaf elevation:", e); }
}

/* -------------------------------------------- */
/*  Patch                                        */
/* -------------------------------------------- */

// `DoorMesh#initialize` is the single place where core computes `_closedPosition`:
// it is called by both the constructor (Wall#createDoorMeshes) and Wall#_onUpdate when
// geometry or animation is edited. One wrapper covers every case.
const PATH = "foundry.canvas.containers.DoorMesh.prototype.initialize";

function _installPatch(isEnabled) {
  const cls = foundry?.canvas?.containers?.DoorMesh;
  if (!cls?.prototype?.initialize) {
    console.warn("[adm-levels] door leaf elevation: DoorMesh not found, tool disabled");
    return;
  }
  const after = function () { try { _fixMesh(this, isEnabled); } catch (_e) {} };

  if (globalThis.libWrapper?.register) {
    libWrapper.register(MODULE_ID, PATH, function (wrapped, ...args) {
      const r = wrapped(...args);
      after.call(this);
      return r;
    }, "WRAPPER");
    return;
  }
  // Without libWrapper — our own wrapper. A post-hook, core behavior is not replaced,
  // so it coexists with other wrappers.
  if (cls.prototype.initialize.__admDoorElev) return;
  const orig = cls.prototype.initialize;
  const patched = function (...args) {
    const r = orig.apply(this, args);
    after.call(this);
    return r;
  };
  patched.__admDoorElev = true;
  cls.prototype.initialize = patched;
}

export const TOOL = {
  id: "doorMeshElevation",
  name: "ADM_LEVELS.settings.doorMeshElevation.name",
  hint: "ADM_LEVELS.settings.doorMeshElevation.hint",

  onReady({ isEnabled }) {
    // The patch is ALWAYS installed: it checks the checkbox itself and returns the
    // core value when off. That way the checkbox works on the fly, without a reload.
    _installPatch(isEnabled);

    const run = foundry.utils.debounce(() => _sweep(isEnabled), 50);

    Hooks.on("canvasReady", run);
    Hooks.on("updateWall", (_doc, changes) => {
      // The wall's own elevation lives in foreign flags — core does not redraw on them.
      if (foundry.utils.hasProperty(changes ?? {}, "flags.wall-height")
          || foundry.utils.hasProperty(changes ?? {}, "flags.core.elevation")) run();
    });
    // Checkbox change (and scene floor edits) — recompute what is already drawn.
    // ⚠️ Two hooks: before the first toggle the setting has NO record in the database, and
    // game.settings.set CREATES it — then createSetting fires, not updateSetting.
    const onSetting = (setting) => { if (setting?.key === SETTING_KEY) run(); };
    Hooks.on("updateSetting", onSetting);
    Hooks.on("createSetting", onSetting);
    Hooks.on("updateScene", (scene, changes) => {
      if (scene?.id !== canvas?.scene?.id) return;
      if (("foregroundElevation" in (changes ?? {}))
          || foundry.utils.hasProperty(changes ?? {}, `flags.${LEVELS_ID}.sceneLevels`)) run();
    });
    run();
  },
};
