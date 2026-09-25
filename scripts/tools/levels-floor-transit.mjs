// scripts/tools/levels-floor-transit.mjs
// ADMaps Tools sub-module: «Descend at path end» — keep walking the floor until the path ends.
//
// PROBLEM. A token is dragged from a roof down to the ground. Core writes the FINAL
// elevation at once and animates the coordinates afterwards (Token#_refreshElevation:
// mesh.elevation comes from document.elevation, not from the animation). From the very
// first frame the token sits at zero — it dives under the roof deck and travels through
// the lower floor in plain view. That is both ugly and meta: unvisited rooms get revealed.
//
// SOLUTION. For the duration of the movement we PIN the render elevation to the old
// one: the token walks along the roof as if it never meant to leave it, and only
// descends at the end of the path. We touch ONLY the picture — the document,
// distance, regions and movement history stay exactly as core computed them.
//
// ⚠️ WHY NOT "HIDE" AND WHY NOT "TELEPORT". Hiding was tried — the token vanished,
// but the roof still dissolved beneath it and the meta remained. Instantaneity in
// v13 is not an update option but a movement with the "displace" action, chosen
// BEFORE the hooks (documents/token.mjs: operation.teleport → action); there is no
// way in from outside without rewriting the movement itself.

const LEVELS_ID = "levels";
const MODULE_ID = "adm-levels";

const ANIM_TIMEOUT_MS = 8000;   // wait ceiling: a stuck animation must not freeze the elevation forever

/** Floor planes come from the system — the single source of truth. */
let _floorPlanes = null;
async function _loadFloorTest() {
  // Only on that system: elsewhere the file does not exist, and the failed import still logs a 404 in the console.
  if (globalThis.game?.system?.id !== "adm-daggerheart") return;
  try {
    const m = await import("/systems/adm-daggerheart/scripts/floor-planes.mjs");
    if (typeof m?._floorPlanes === "function") _floorPlanes = m._floorPlanes;
  } catch (_e) { /* different system — fall back to the backup rule */ }
}

/**
 * Does the path leave the floor? There is a floor slab between the elevations with
 * AT LEAST ONE of the points — origin or destination — lying under it.
 *
 * ⚠️ THREE traps, each of which made a version silently do nothing:
 * 1) Only ONE point was taken — the current one. By the time of the event the token
 *    is already in the new cell. BOTH are needed: origin and destination.
 * 2) The elevation interval was NARROWED. But the token stands EXACTLY on the roof
 *    plane: 15 with a plane at 15 — by narrowing we threw that plane out. Widen it.
 * 3) The ready-made admFloorSeparates was used — but it requires BOTH points under
 *    one tile: that is the area-attack rule ("floor separates"). The task here is
 *    different — "does the path leave the floor" — and leaving the roof OUTWARD does
 *    not fit it at all: the second point is already outside the outline. Need "at least one".
 */
function _crossesFloor(aPt, z0, bPt, z1) {
  try {
    if (!_floorPlanes || !aPt || !bPt) return z0 !== z1;
    const planes = _floorPlanes();
    // ⚠️ No planes at all does NOT mean "transitions never happen". The system
    // treats only a tile with an EXPLICITLY set range top as a floor, and a
    // "roof without a ceiling" from the Levels tool does not qualify. On such a
    // scene we hold the elevation on any change of it during movement: the pin is
    // purely visual and lives exactly one animation, firing once too often is harmless.
    if (!planes?.length) return z0 !== z1;
    const eps = Math.min(1, (Number(canvas?.scene?.grid?.distance) || 5) / 10);
    const lo = Math.min(z0, z1) - eps;
    const hi = Math.max(z0, z1) + eps;
    for (const pl of planes) {
      if (!(pl.z > lo && pl.z < hi)) continue;
      const m = pl.tile?.mesh;
      if (!m?.containsCanvasPoint) continue;
      if (m.containsCanvasPoint(aPt, 0.1) || m.containsCanvasPoint(bPt, 0.1)) return true;
    }
    return false;
  } catch (_e) { return z0 !== z1; }
}

/**
 * Wait for the END of the movement.
 *
 * ⚠️ The previous version asked for the animation promise right away and, not
 * finding one, waited a fixed 300 ms. But the animation had not even started by
 * then: the pin was released halfway, and the token calmly dived down — debugging
 * showed "after 350ms … pin: null" while the elevation had already slid to 12 of 15.
 * Therefore: let the animation start and POLL while it runs.
 */
async function _awaitMovement(token, pinZ = null) {
  const deadline = Date.now() + ANIM_TIMEOUT_MS;
  const QUIET_MS = 250;          // this long of continuous quiet before we believe it
  let quietSince = null;
  await new Promise(r => setTimeout(r, 60));      // let the animation start
  while (Date.now() < deadline) {
    let busy = false;
    try {
      const doc = token.document;
      // ⚠️ Release AS SOON AS the elevation has actually left the old value. Holding
      // longer is not allowed: past the edge the token is already on the ground per
      // the data, and if we keep drawing it on the roof, vision is computed from
      // below — shadows of the lower floor's walls bleed through the picture. The
      // rendering must follow the data, not run ahead of it.
      const curZ = Number(doc?.elevation);
      if (pinZ != null && Number.isFinite(curZ) && curZ !== Number(pinZ)) break;
      // ⚠️ The MAIN sign of "still moving": during movement the document returns
      // ANIMATED values while the raw _source is already final. As long as they
      // differ, the path is not finished. "Animation contexts" alone are not enough:
      // the path goes through several points, the animation pauses for an instant
      // between them, and the poll took that pause for the finish — the pin was released mid-roof.
      const settled = Number(doc?.elevation) === Number(doc?._source?.elevation)
        && Number(doc?.x) === Number(doc?._source?.x)
        && Number(doc?.y) === Number(doc?._source?.y);
      busy = !settled
        || (token.animationContexts?.size ?? 0) > 0
        || !!globalThis.CanvasAnimation?.getAnimation?.(token.animationName)
        || !!token.movementAnimationPromise;
    } catch (_e) { break; }
    if (busy) quietSince = null;
    else if (quietSince == null) quietSince = Date.now();
    else if (Date.now() - quietSince >= QUIET_MS) break;
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Redraw what Levels computes from the vision height (roof visibility). */
function _refreshLevels() {
  try { CONFIG.Levels?.handlers?.RefreshHandler?.refreshPlaceables?.(); } catch (_e) {}
}

function _pin(token, z) {
  // EYE height above the feet — keep the previous difference so the substituted
  // height looks natural (wall-height computes it from the token size).
  let eyes = 0;
  try { eyes = Math.max(0, (Number(token.losHeight) || 0) - (Number(token.document?.elevation) || 0)); } catch (_e) {}
  token.__admTransitEyes = eyes;
  token.__admTransitPin = z;
  // ⚠️ The vision height is NOT substituted permanently. That was tried — and gave
  // a spoiler: the player's vision is computed from it, and a token on the roof
  // looks over the first-floor walls (their ceiling is 15, eyes at 21.7), so the
  // whole floor was revealed in the fog for the entire path. The substitution now
  // lives strictly inside one Levels call — see the isTileVisible wrapper in onReady.
  try { if (token.mesh) token.mesh.elevation = z; } catch (_e) {}
  _refreshLevels();
  if (globalThis.__ADM_LEVELS_TRANSIT_DEBUG) {
    console.info("[adm-levels] holding elevation:", z, "| eye height:", z + eyes,
      "| mesh.elevation:", token.mesh?.elevation);
  }
}

function _unpin(token) {
  if (token?.__admTransitPin == null) return;
  token.__admTransitPin = null;
  token.__admTransitEyes = 0;
  try { token._refreshElevation?.(); } catch (_e) {}
  // ⚠️ Recompute VISION. While the pin was set, vision was computed from the old
  // elevation; without an explicit recompute it stays that way until the player's
  // first step — hence "lower-floor walls are visible until I move".
  // ⚠️ The flag is named `initializeVision`. There is NO `initializeVisionSources`
  // flag in v13 (canvas/perception/perception-manager.mjs, RENDER_FLAGS) — with it
  // the recompute was a no-op and vision stayed computed from the roof: the player
  // saw the whole first floor without walls until they moved.
  try { token.initializeVisionSource?.(); } catch (_e) {}
  try {
    canvas?.perception?.update?.({
      initializeVision: true,
      initializeLighting: true,
      refreshVision: true,
      refreshLighting: true,
      refreshOcclusion: true,
    });
  } catch (_e) {}
  _refreshLevels();
}

export const TOOL = {
  id: "levelsFloorTransit",
  name: "ADM_LEVELS.settings.levelsFloorTransit.name",
  hint: "ADM_LEVELS.settings.levelsFloorTransit.hint",
  settingScope: "client",   // what to show yourself is a personal matter

  onReady({ isEnabled }) {
    if (!game.modules.get(LEVELS_ID)?.active) return;

    _loadFloorTest();

    // While the "pin" is set, the render elevation is taken from it. Core calls
    // _refreshElevation on every redraw, so a single write to the mesh is not enough.
    try {
      if (globalThis.libWrapper?.register) {
        libWrapper.register(
          MODULE_ID,
          "CONFIG.Token.objectClass.prototype._refreshElevation",
          function (wrapped, ...args) {
            const pin = this.__admTransitPin;
            if (pin == null) return wrapped(...args);
            if (this.mesh) this.mesh.elevation = pin;
          },
          "MIXED",
        );
      }
    } catch (e) { console.warn("[adm-levels] floor transit: elevation wrapper", e); }

    // ⚠️ THE KEY SPOT. Roof visibility is decided by Levels in TileHandler.isTileVisible,
    // and during movement it looks AT THE FINAL elevation, not the current one:
    //   movementDelta = movement.destination.elevation − document.elevation
    //   tokenLOS      = currentToken.losHeight + movementDelta
    // So the moment you drag downward, Levels immediately considers you on the first
    // floor, and the roof moves up away from you from the very first frame.
    //
    // We substitute the height ONLY for the duration of this call: the player's vision
    // is computed elsewhere and from the real height, so the spoiler is gone. We also
    // compensate movementDelta itself — otherwise Levels subtracts it from the substituted value.
    try {
      if (globalThis.libWrapper?.register && CONFIG.Levels?.handlers?.TileHandler) {
        libWrapper.register(
          MODULE_ID,
          "CONFIG.Levels.handlers.TileHandler.isTileVisible",
          function (wrapped, ...args) {
            const tok = CONFIG.Levels?.currentToken;
            const pin = tok?.__admTransitPin;
            if (pin == null || !isEnabled()) return wrapped(...args);
            let desc = null;
            try {
              const doc = tok.document;
              const delta = (Number(doc?.movement?.destination?.elevation ?? doc?.elevation) || 0)
                - (Number(doc?.elevation) || 0);
              const desired = pin + (tok.__admTransitEyes ?? 0);
              const fake = desired - delta;      // Levels will add delta back
              desc = Object.getOwnPropertyDescriptor(tok, "losHeight") ?? null;
              Object.defineProperty(tok, "losHeight", { configurable: true, get: () => fake });
            } catch (_e) { /* could not substitute — let it compute as is */ }
            try { return wrapped(...args); }
            finally {
              try {
                if (desc) Object.defineProperty(tok, "losHeight", desc);
                else delete tok.losHeight;
              } catch (_e) {}
            }
          },
          "WRAPPER",
        );
      }
    } catch (e) { console.warn("[adm-levels] floor transit: tile visibility wrapper", e); }

    // ⚠️ The "FROM" point and elevation are captured BEFORE the update: in updateToken
    // the document is already new, and there is nowhere to get the old place from.
    const _from = new Map();   // id → {cx, cy, z}
    Hooks.on("preUpdateToken", (doc, changes, options) => {
      try {
        if (!isEnabled()) return;
        if (!("elevation" in (changes ?? {}))) return;
        if (options?.teleport) return;
        const tok = doc.object;
        // Raw _source: the animation does not touch it (see the note at the "TO" point).
        const z0 = Number(doc._source?.elevation ?? doc.elevation) || 0;
        _from.set(doc.id, {
          cx: (Number(doc._source?.x ?? doc.x) || 0) + ((tok?.w ?? 0) / 2),
          cy: (Number(doc._source?.y ?? doc.y) || 0) + ((tok?.h ?? 0) / 2),
          z: z0,
        });
        // ⚠️ The pin is set ALREADY HERE, before the new elevation is written. Otherwise
        // a one-frame window remains: the document is already on the ground but the
        // pin is not yet — core manages to recompute vision from the new elevation,
        // and in rare cases a lower-floor spoiler slipped through. Now we pin to the
        // CURRENT elevation, i.e. visually nothing changes; if the transition turns
        // out to be unneeded, we release it in updateToken in the same tick.
        if (tok) {
          _pin(tok, z0);
          // Safety net: the update might not have happened at all (another hook returned false).
          // Then updateToken never arrives and nobody would release the pin.
          setTimeout(() => {
            if (!_from.has(doc.id)) return;   // updateToken has run — stay out of the way
            _from.delete(doc.id);
            _unpin(tok);
          }, 1500);
        }
      } catch (_e) { /* could not capture — the transition simply will not be pinned */ }
    });

    Hooks.on("updateToken", (doc, changes, options) => {
      let prev = _from.get(doc.id) ?? null;
      const pinnedAlready = !!prev;
      _from.delete(doc.id);
      const token = doc.object;
      let keep = false;   // hold the pin until the end of the movement?
      try {
        if (!isEnabled()) return;
        // ⚠️ On the OTHER CLIENTS preUpdateToken does not fire at all — it only runs
        // for whoever initiated the update. So an observer has no "from" point and
        // the pin was never set: the player saw the first floor wide open while the
        // GM dragged the token. Restore the path start from the document itself:
        // core fills movement.origin on every client.
        if (!prev) {
          const org = doc.movement?.origin;
          if (org && Number.isFinite(Number(org.elevation))) {
            prev = {
              cx: (Number(org.x) || 0) + ((token?.w ?? 0) / 2),
              cy: (Number(org.y) || 0) + ((token?.h ?? 0) / 2),
              z: Number(org.elevation) || 0,
            };
          }
        }
        // ⛔ TELEPORT gets no pin: there is nothing to hide — no path, the token
        // appears in place. And pinning the vision height even for a fraction of a
        // second is harmful: vision is computed for the OLD floor and stays that way
        // until the player moves — "lower-floor walls are visible after a teleport".
        if (options?.teleport) return;
        // Only a transition BETWEEN floors WITH movement: a descent in place has
        // nothing to show, no point pinning the elevation there.
        if (!("elevation" in (changes ?? {}))) return;
        if (!("x" in (changes ?? {})) && !("y" in (changes ?? {}))) return;

        if (!token || !prev) return;
        const z1 = Number(changes.elevation);
        if (!Number.isFinite(z1) || z1 === prev.z) return;

        // ⚠️ The "TO" point is taken from changes, not from doc.x/doc.y: during movement
        // v13 returns ANIMATED values for them, and on the first frame that is still
        // the old place — in debugging "from" and "to" coincided. The fallback is the
        // raw _source, which the animation does not touch.
        const _nx = Number(changes.x ?? doc._source?.x ?? doc.x) || 0;
        const _ny = Number(changes.y ?? doc._source?.y ?? doc.y) || 0;
        const to = { x: _nx + ((token.w ?? 0) / 2), y: _ny + ((token.h ?? 0) / 2) };
        const crosses = _crossesFloor({ x: prev.cx, y: prev.cy }, prev.z, to, z1);
        if (globalThis.__ADM_LEVELS_TRANSIT_DEBUG) {
          console.info("[adm-levels] transit:", doc.name,
            "| from:", prev.cx.toFixed(0), prev.cy.toFixed(0), "@", prev.z,
            "| to:", to.x.toFixed(0), to.y.toFixed(0), "@", z1,
            "| leaves floor:", crosses);
        }
        if (!crosses) return;
        keep = true;
        // On an observer client there is no pin yet — set it here. That is one frame
        // later than on the initiator, but the path lasts far longer.
        if (!pinnedAlready) _pin(token, prev.z);
      } catch (_e) { /* one token must not bring down the hook */ }
      finally {
        // The pin has been set since preUpdateToken. Here we only decide its fate:
        // hold until the end of the movement, or release in this same tick if the
        // transition is not ours (visually nothing changed — we pinned to the current elevation).
        if (!token) { /* nothing to release */ }
        else if (keep) _awaitMovement(token, token.__admTransitPin).then(() => _unpin(token));
        else _unpin(token);
      }
    });

    // Safety net: an interrupted animation (scene change, deletion, F5) must not
    // leave the render elevation pinned forever.
    Hooks.on("canvasReady", () => {
      for (const t of (canvas?.tokens?.placeables ?? [])) _unpin(t);
    });
  },
};
