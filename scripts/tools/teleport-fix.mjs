// scripts/tools/teleport-fix.mjs
// ADMaps Tools sub-module: fixes the "Teleport Token" Region behavior when regions move
// to another scene (formerly the standalone admaps-teleport module).
//
// Foundry stores the teleport destination as a Region UUID "Scene.<sceneId>.Region.<regionId>"
// and NEVER recomputes it on copy (the opposite example is adventure import, where ids are
// deliberately kept intact so that references stay valid). Hence three DIFFERENT cases:
//
// 1) SCENE DUPLICATE. Foundry keeps the embedded region ids (keepEmbeddedIds=true by default) →
//    the copy has the same regionIds, ONLY the scene segment is wrong. We take the source from
//    scene._stats.duplicateSource and rewrite the segment as a string. Works even if the original
//    was deleted. Trigger — createScene.
//
// 1a) SCENE MOVED TO ANOTHER WORLD via a JSON file — exactly the same breakage as case 1, only
//    the origin marker differs: the scene gets a NEW id, the regions keep theirs. On export the
//    core puts the source scene uuid into _stats.exportSource.uuid — that serves as the source
//    (see _selfSceneIds). Two triggers: createScene — for paths where the scene is CREATED (there
//    _stats from the data does arrive), and the Scene#importFromJSON wrapper — for "Import Data"
//    into an existing scene, where the hook is useless: the server overwrites _stats with the receiver's (see _wrapImport).
//    ⚠️ The exporter is responsible for putting the export marker into the file. Our scene-export-name once wrote
//    the obsolete v12 form flags.exportSource WITHOUT uuid, the core shim substituted null — and there
//    was nothing to fix with. When editing that file, do not lose `uuid: this.uuid` again.
//
// 2) PASTING REGIONS onto an existing scene: Mass Edit preset, copy&paste, drag&drop. Here
//    createEmbeddedDocuments goes WITHOUT keepId → the server gives the region a NEW id, while the nested
//    behaviors keep their ids along with the old destination string. The trick from case 1 ("the
//    same regionId") won't work: the old id is no longer on the scene at all. We need a map "old id →
//    new", and the old id is visible exactly once — in preCreate, in the operation's source data
//    (client-backend.mjs: Hooks.call(`preCreate${type}`, doc, d, ...) — `d` still has the preset's _id).
//    So we remember it in a service flag on the region itself and process the whole batch after
//    creation: the create hooks of one batch are called synchronously back to back.
//    ⚠️ We fix ONLY teleports whose TARGET arrived in the SAME batch. If the target stayed on the previous
//    scene — that is a deliberate cross-scene transition, we leave it alone.
//    ⚠️ RESTORE is not a paste. Undo of a deletion and Mass Edit undo go with keepId, the region
//    comes back under its own id. We cut this off twice: we don't write the flag (so undo restores the document
//    as it was) and we don't put a region whose id didn't change into the map. Otherwise after a scene duplicate — where the
//    region ids of the original and the copy are SHARED — a deliberate cross-scene teleport would silently become local.

const MODULE_ID = "adm-levels";
const TELEPORT_TYPE = "teleportToken";
// flags.adm-levels.srcRegionId — the region id BEFORE the paste. We deliberately do NOT remove the flag
// after processing the batch: the cleanup would cost an extra update operation right after the paste, and
// foreign updateRegion handlers (including our own elevation magnet) and Mass Edit undo would pick it up. A 16-character
// string is harmless and gets overwritten with a fresh id on the next paste.
const SRC_FLAG = "srcRegionId";

/** Read a flag without getFlag (which throws on an unregistered namespace). */
const _flagGet = (doc, key) => foundry.utils.getProperty(doc?.flags ?? {}, `${MODULE_ID}.${key}`);

/** "Scene.<sceneId>.Region.<regionId>" → {sceneId, regionId}, otherwise null. */
function _parseRegionUuid(uuid) {
  const p = String(uuid ?? "").split(".");
  if (p.length === 4 && p[0] === "Scene" && p[2] === "Region") return { sceneId: p[1], regionId: p[3] };
  return null;
}

/** "Scene.<id>" → id, otherwise null. Shared parser for both origin markers. */
function _parseSceneUuid(uuid) {
  const p = String(uuid ?? "").split(".");
  return (p.length === 2 && p[0] === "Scene") ? p[1] : null;
}

/** id of the duplicate's source scene (scene._stats.duplicateSource = "Scene.<id>"), otherwise null. */
function _sourceSceneId(scene) {
  return _parseSceneUuid(scene?._stats?.duplicateSource);
}

/**
 * ids of scenes that, for THIS scene, mean "itself in a past life". A teleport
 * pointing at such a scene is actually local and must be re-pointed at this scene.
 *
 * There are two sources, and they are NOT equivalent — different meaning, different cost of error:
 *
 *  • exportSource.uuid — the FORMER uuid of THIS VERY document: on export the core writes
 *    `uuid: this.uuid`. So a teleport pointing at it was, at export time, the scene's
 *    reference to itself, and re-pointing it at this scene is an identity operation,
 *    not a guess. Hence the single condition: `exp !== scene.id`. It cuts off exactly
 *    one safe case — when the ids were preserved (adventure import, returning the file
 *    to the same scene) and there is nothing left to re-point.
 *    ⚠️ This used to be "the named scene does not exist in the world". That check is wrong: a copy
 *    made by export-import WITHIN one world kept pointing at the original.
 *
 *  • duplicateSource — the uuid of ANOTHER document: the scene this one was cloned FROM. It is
 *    usually alive, and its teleports work. Re-pointing them at this scene is a product
 *    decision ("the copy must walk its own floors"), not an identity, so we take the marker
 *    only where the intent is unambiguous:
 *      — allowDuplicate=false on import into an existing scene. A living scene could have had a
 *        deliberate reference to its ancestor for years, and silently re-pointing it is data loss;
 *      — the marker must not be imported. The core in clone() writes duplicateSource and immediately
 *        nulls exportSource, so a REAL duplicate always has exportSource == null,
 *        while a duplicate that arrived inside a JSON file does not. Since the export stopped
 *        clearing the markers (clearSource:false, as in the core), this distinction became mandatory.
 */
function _selfSceneIds(scene, { allowDuplicate = true, sourceSceneId = null } = {}) {
  const ids = new Set();
  // Anchor captured directly by the caller (file import — see _wrapImport). Needed because
  // it never reaches the document: on recursive:false the server replaces _stats entirely.
  if (sourceSceneId && sourceSceneId !== scene?.id) ids.add(sourceSceneId);
  const exp = _parseSceneUuid(scene?._stats?.exportSource?.uuid);
  if (exp && exp !== scene?.id) ids.add(exp);
  const dup = _sourceSceneId(scene);
  if (dup && allowDuplicate && scene?._stats?.exportSource == null) ids.add(dup);
  return ids;
}

/** Rewrite teleports pointing at the source scene onto the regions of THIS scene. Returns the count. */
async function _remapSelfTeleports(scene, opts) {
  const selfIds = _selfSceneIds(scene, opts);
  if (!selfIds.size || !scene?.regions) return 0;
  let fixed = 0;
  for (const region of scene.regions) {
    const updates = [];
    for (const behavior of (region.behaviors ?? [])) {
      if (behavior.type !== TELEPORT_TYPE) continue;
      const parsed = _parseRegionUuid(behavior.system?.destination);
      if (!parsed || !selfIds.has(parsed.sceneId)) continue; // only teleports to the SOURCE SCENE
      const target = scene.regions.get(parsed.regionId);     // the copy kept this regionId
      if (!target) continue;                                 // region is not here → leave it alone
      if (target.uuid === behavior.system.destination) continue; // already points here
      updates.push({ _id: behavior.id, "system.destination": target.uuid });
    }
    if (updates.length) { await region.updateEmbeddedDocuments("RegionBehavior", updates); fixed += updates.length; }
  }
  return fixed;
}

// ── Case 2: regions pasted onto a scene ─────────────────────────────────────────────────────

let _batch = [];          // regions of one paste batch
let _batchScheduled = false;

/** Rewrite teleports inside the JUST pasted batch onto its own new regions. */
async function _remapPastedRegions(regions) {
  // Map "region id before paste → pasted region". Keyed by this batch only:
  // a target outside the batch stayed on the previous scene, and that is a deliberate cross-scene transition.
  // The key includes the scene: a batch can in principle mix regions of different scenes, and re-pointing
  // a teleport at a region of ANOTHER scene is not allowed.
  const _key = (sceneId, regionId) => `${sceneId}|${regionId}`;
  const bySrcId = new Map();
  const ambiguous = new Set();
  for (const region of regions) {
    const srcId = _flagGet(region, SRC_FLAG);
    if (!srcId) continue;
    // ⚠️ The sign of a real paste — the server issued a DIFFERENT id. Same id → came with keepId
    // (undo of a deletion, Mass Edit undo): the region came back under its own id, nothing to re-point.
    // Without this check, after a scene duplicate (where region ids are shared) a deliberate cross-scene
    // teleport would silently become local.
    if (srcId === region.id) continue;
    const k = _key(region.parent?.id, srcId);
    if (bySrcId.has(k)) { ambiguous.add(k); continue; } // one source region arrived twice
    bySrcId.set(k, region);
  }
  if (!bySrcId.size) return 0;

  let fixed = 0;
  for (const region of regions) {
    const updates = [];
    for (const behavior of (region.behaviors ?? [])) {
      if (behavior.type !== TELEPORT_TYPE) continue;
      const parsed = _parseRegionUuid(behavior.system?.destination);
      if (!parsed) continue;
      const k = _key(region.parent?.id, parsed.regionId);
      if (ambiguous.has(k)) continue;                       // which copy to pick — not for us to decide
      const target = bySrcId.get(k);                        // did the target arrive together with us?
      if (!target || target.uuid === behavior.system.destination) continue;
      updates.push({ _id: behavior.id, "system.destination": target.uuid });
    }
    if (updates.length) { await region.updateEmbeddedDocuments("RegionBehavior", updates); fixed += updates.length; }
  }
  return fixed;
}

// ── Case 1a: JSON import into an existing scene ─────────────────────────────────────────────

/**
 * Scene#importFromJSON wrapper: capture the anchor FROM THE FILE and fix teleports after import.
 *
 * ⚠️ WHY NOT A HOOK. Hooks.on("updateScene") suggests itself, and it even fires (preUpdate
 * is muted by noHook, the post-hook is not). But the marker is already GONE in it: importFromJSON commits the file
 * via update(..., {recursive:false}), and the server in tagModelStats on recursive===false
 * does `deepClone(document._stats)` and overwrites the incoming _stats entirely with it
 * (dist/database/backend, called from _preUpdate). So the RECEIVER's _stats reaches the scene,
 * and exportSource from the file is lost on the way. The only place where it is still visible is
 * here, before the core call. The first version of this fix hung on the hook and silently did nothing.
 *
 * We read only the marker; the JSON itself and the import order are untouched. On any parse error
 * the import proceeds as usual, just without the fix.
 */
function _wrapImport(wrapped, args, isEnabled) {
  const done = wrapped(...args);
  if (!isEnabled() || this?.documentName !== "Scene") return done;
  let srcId = null;
  try { srcId = _parseSceneUuid(JSON.parse(args?.[0] ?? "")?._stats?.exportSource?.uuid); }
  catch (_e) { return done; } // not our format / broken file — silently skip
  if (!srcId) return done;
  return Promise.resolve(done).then(async (result) => {
    try {
      // allowDuplicate:false — the scene exists and lives its own life: it could have set up
      // a reference to its ancestor scene deliberately. We fix strictly by the anchor from the file.
      const fixed = await _remapSelfTeleports(this, { allowDuplicate: false, sourceSceneId: srcId });
      if (fixed) ui.notifications.info(`ADMaps Teleport: remapped ${fixed} teleport destination(s) on the imported scene "${this.name}".`);
    } catch (e) { console.error("[ADM:Tools:teleport] import remap:", e); }
    return result;
  });
}

/** Install the wrapper once: libWrapper if present, otherwise a direct prototype patch. */
function _installImportWrap(isEnabled) {
  if (globalThis.libWrapper?.register) {
    try {
      libWrapper.register(MODULE_ID, "Scene.prototype.importFromJSON", function (wrapped, ...args) {
        return _wrapImport.call(this, wrapped, args, isEnabled);
      }, "WRAPPER");
      return;
    } catch (e) { console.warn("[ADM:Tools:teleport] libWrapper failed, falling back to direct patch:", e); }
  }
  const proto = globalThis.Scene?.prototype;
  const orig = proto?.importFromJSON;
  if (typeof orig !== "function" || orig.__admTeleportFix) return;
  const patched = function (...args) { return _wrapImport.call(this, orig.bind(this), args, isEnabled); };
  patched.__admTeleportFix = true;
  proto.importFromJSON = patched;
}

/** Does the scene have at least one Teleport Token behavior? (relevance gate for the menu entry) */
function _sceneHasTeleports(scene) {
  for (const region of (scene?.regions ?? []))
    for (const behavior of (region.behaviors ?? []))
      if (behavior.type === TELEPORT_TYPE) return true;
  return false;
}

export const TOOL = {
  id: "teleportFix",
  name: "ADM_LEVELS.settings.teleportFix.name",
  hint: "ADM_LEVELS.settings.teleportFix.hint",
  replaces: ["admaps-teleport"],

  onReady({ isEnabled }) {
    // Auto: after a scene is created (duplicate/import) localize its self-teleports. Only the creating GM writes.
    Hooks.on("createScene", async (scene, options, userId) => {
      try {
        if (!isEnabled()) return;
        if (!game.user?.isGM || game.user.id !== userId) return;
        // ⚠️ keepId — the caller's explicit statement "I kept the ids" (adventure import does
        // this). So the scene segment in destination is valid too, nothing to fix, and
        // intervening would break working cross-scene references. Same trick as in the
        // region paste branch below.
        if (options?.keepId || options?.isUndo) return;
        const fixed = await _remapSelfTeleports(scene);
        if (fixed) ui.notifications.info(`ADMaps Teleport: remapped ${fixed} teleport destination(s) to the copied scene "${scene.name}".`);
      } catch (e) { console.error("[ADM:Tools:teleport] auto remap:", e); }
    });

    // Case 1a: "Import Data" into an EXISTING scene — the most common way to hand out a map.
    _installImportWrap(isEnabled);

    // Case 2, step 1: remember the region id BEFORE the paste. Visible only here — the server will issue a new one.
    // A region drawn by hand has no incoming _id → no flag is set (this is exactly the difference
    // between "pasted" and "created").
    Hooks.on("preCreateRegion", (region, data, options) => {
      try {
        if (!isEnabled()) return;
        // ⚠️ Restore (undo of a deletion, Mass Edit undo) goes with keepId: the region will come back
        // under its own id, nothing to re-point. Stay silent so that undo restores the document as it was.
        if (options?.isUndo || options?.keepId) return;
        const srcId = data?._id;
        if (!srcId) return;
        region.updateSource({ [`flags.${MODULE_ID}.${SRC_FLAG}`]: srcId });
      } catch (e) { console.error("[ADM:Tools:teleport] remember region id:", e); }
    });

    // Case 2, step 2: process the WHOLE batch. The create hooks of one batch are called synchronously
    // back to back (client-backend: callbacks.map(fn => fn())), so a 0 timer catches them all.
    // ⚠️ Waiting for the batch is mandatory: a teleport may point at a region created AFTER itself.
    Hooks.on("createRegion", (region, _options, userId) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM || game.user.id !== userId) return; // only the one who pasted writes
      if (!_flagGet(region, SRC_FLAG)) return;
      _batch.push(region);
      if (_batchScheduled) return;
      _batchScheduled = true;
      setTimeout(async () => {
        const regions = _batch;
        _batch = [];
        _batchScheduled = false;
        try {
          const fixed = await _remapPastedRegions(regions);
          if (fixed) ui.notifications.info(`ADMaps Teleport: repointed ${fixed} pasted teleport destination(s) to the regions of this scene.`);
        } catch (e) { console.error("[ADM:Tools:teleport] paste remap:", e); }
      }, 0);
    });

    // Manual "Fix teleport destinations" entry in the scene context menu — for scenes that arrived
    // before the tool was enabled: both duplicates and imports (the condition below checks both origin markers).
    Hooks.on("getSceneContextOptions", (directory, entries) => {
      // ⚠️ This hook is called NOT only by the scene directory and navigation: Compendium inherits
      // DocumentDirectory and builds its menu under the same hook name. And getScene looks the row up in
      // game.scenes — that is the WORLD collection, the pack is not in it. Usually a miss and the entry
      // is simply hidden, but the ids of a world scene and a pack entry legitimately coincide (import with
      // keepId), and then the entry would pop up on the compendium row while fixing a different scene
      // from the world. Compendiums are cut off right away.
      if (directory?.collection instanceof foundry.documents.collections.CompendiumCollection) return;
      const getScene = (li) => {
        const el = li.closest("[data-entry-id]") ?? li.closest("[data-scene-id]");
        return game.scenes.get(el?.dataset.entryId ?? el?.dataset.sceneId);
      };
      entries.push({
        name: "Fix teleport destinations",
        icon: '<i class="fa-solid fa-crosshairs"></i>',
        condition: (li) => {
          if (!isEnabled()) return false;
          const scene = getScene(li);
          return game.user.isGM && _selfSceneIds(scene).size > 0 && _sceneHasTeleports(scene);
        },
        callback: async (li) => {
          try {
            const scene = getScene(li);
            if (!scene) return;
            const fixed = await _remapSelfTeleports(scene);
            if (fixed) ui.notifications.info(`ADMaps Teleport: remapped ${fixed} teleport destination(s) on "${scene.name}" to its own regions.`);
            else ui.notifications.info(`ADMaps Teleport: no copied teleport destinations found on "${scene.name}".`);
          } catch (e) {
            console.error("[ADM:Tools:teleport] manual remap:", e);
            ui.notifications.error("ADMaps Teleport: failed to remap teleport destinations (see console).");
          }
        },
      });
    });
  },
};
