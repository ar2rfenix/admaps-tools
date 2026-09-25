// scripts/tools/massedit-mirror-fix.mjs
// ADMaps Tools sub-module: extends the BUILT-IN Mass Edit mirroring with what it does not know about —
// the direction of our regions (plateaus/stairs, `flags.adm-levels.direction`).
//
// Why: Mass Edit can mirror a selection on its own (Shift+D → H/V, and the same H/V when spawning a preset),
// around the center of the selection box. But it naturally knows nothing about foreign flags: a mirrored house
// ends up with a plateau whose ascent direction points the wrong way.
//
// ⚠️ We patch NOT the Mass Edit files (an update would overwrite them) but its method in memory. The point was
// chosen deliberately: MassTransformer.prototype.applyTransform receives the transform object (which holds
// mirrorX/mirrorY) and works on exactly the data the result is later written from
// (transformer.update() reads _docToData — the same objects as in the preview). So the fix
// survives until the write and works the same both in the preview and on confirm.

const MODULE_ID = "adm-levels";
const DIR_PATH = `flags.${MODULE_ID}.direction`;

let _patched = false;

/**
 * Reflects an angle using the "0° = up, clockwise" convention — the same as angUp in scene-flip.
 * ⚠️ There are two conventions: rotation has zero "up", template direction is measured from the X axis. Our
 * region direction flag is of the first kind, hence exactly this formula.
 */
function _reflectDirection(deg, flipX, flipY) {
  let r = ((Number(deg) % 360) + 360) % 360;
  if (flipX) r = (360 - r) % 360;
  if (flipY) r = (180 - r + 360) % 360;
  return r;
}

/** Data of the regions taking part in the current transform. */
function _regionData(transformer) {
  const out = [];
  if (transformer?._previews) {
    for (const pc of transformer._previews) if (pc?.documentName === "Region" && pc.data) out.push(pc.data);
  } else {
    for (const d of (transformer?._docToData?.get?.("Region") ?? [])) if (d) out.push(d);
  }
  return out;
}

function _fixDirections(transformer, transform) {
  const flipX = !!transform?.mirrorX;
  const flipY = !!transform?.mirrorY;
  if (!flipX && !flipY) return;                    // not a mirror (rotate/scale/move) — none of our business
  for (const data of _regionData(transformer)) {
    const dir = foundry.utils.getProperty(data, DIR_PATH);
    if (dir === undefined || dir === null || dir === "") continue;
    foundry.utils.setProperty(data, DIR_PATH, _reflectDirection(dir, flipX, flipY));
  }
}

function _install() {
  if (_patched) return true;
  const Cls = globalThis.MassTransformer;
  if (!Cls?.prototype?.applyTransform) return false;

  const patchFn = function (wrapped, transform, origin) {
    const res = wrapped.call(this, transform, origin);
    try { _fixDirections(this, transform); }
    catch (e) { console.warn("[ADM:Tools:meMirrorFix] region direction fix failed:", e); }
    return res;
  };

  // libWrapper — if available (coexists with other wrappers); otherwise an honest prototype patch.
  const lw = globalThis.libWrapper;
  if (lw?.register) {
    try {
      lw.register(MODULE_ID, "MassTransformer.prototype.applyTransform", patchFn, "WRAPPER");
      _patched = true;
      return true;
    } catch (e) { console.warn("[ADM:Tools:meMirrorFix] libWrapper refused, falling back to a direct patch:", e); }
  }
  const original = Cls.prototype.applyTransform;
  Cls.prototype.applyTransform = function (transform, origin) {
    return patchFn.call(this, original, transform, origin);
  };
  _patched = true;
  return true;
}

export const TOOL = {
  id: "massEditMirrorFix",
  name: "ADM_LEVELS.settings.massEditMirrorFix.name",
  hint: "ADM_LEVELS.settings.massEditMirrorFix.hint",
  requiresReload: true,   // the patch is installed once at startup — unchecking requires a reload

  onReady({ isEnabled }) {
    if (!isEnabled()) return;
    if (!game.modules.get("multi-token-edit")?.active) return;
    if (!_install()) {
      console.warn("[ADM:Tools:meMirrorFix] MassTransformer not found — patch not installed.");
    }
  },
};
