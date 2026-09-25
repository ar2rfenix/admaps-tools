// scripts/tools/levels-effect-floors.mjs
// ADMaps Tools sub-module: "Effects on own floor".
//
// THE PROBLEM. Sequencer knows nothing about floors (its bundle has not a single
// reference to Levels), and Levels knows nothing about Sequencer. So every animation
// plays for everyone at once: a "Wall of Flame" on the first floor is visible to those on the roof too.
//
// WHY WE HIDE INSTEAD OF "PLAYING FOR SELECTED USERS". Picking the viewers at launch time
// (Sequencer can do that) would kill LONG-LIVED effects: a wall of fire placed
// while you are upstairs would never appear — not even after you come down. So the
// effect is created for everyone, and on the client it is switched off via `renderable`,
// with the decision revisited on every floor change. One-shot flashes are unaffected: they
// end before you could switch floors anyway.
//
// ⚠️ `renderable` is the same knob Sequencer itself uses in _reinitialize,
// so after its re-initialization our decision must be applied again: that is
// why we listen to createSequencerEffect, not only to floor changes.

const LEVELS_ID = "levels";

// The "separated by a ceiling" test is taken from the system — the single source of truth
// (the same function computes AOE attack and aura hits). If it does not load, we fall
// back to the "same floor" rule.
let _floorSeparates = null;
async function _loadFloorTest() {
  // Only on that system: elsewhere the file does not exist, and the failed import still logs a 404 in the console.
  if (globalThis.game?.system?.id !== "adm-daggerheart") return;
  try {
    const m = await import("/systems/adm-daggerheart/scripts/floor-planes.mjs");
    if (typeof m?.admFloorSeparates === "function") _floorSeparates = m.admFloorSeparates;
  } catch (_e) { /* different game system — the fallback rule stays */ }
}

/**
 * The document the system tagged the effect with (Sequencer origin = template uuid).
 * For effects placed by bare coordinates this is the only way to learn
 * their real floor.
 */
function _originDoc(eff) {
  try {
    const o = eff?.data?.origin;
    if (typeof o !== "string" || !o.includes(".")) return null;
    return fromUuidSync?.(o) ?? null;
  } catch (_e) { return null; }
}

/** The effect's point on the map (for the separation test). */
function _effectPoint(eff) {
  try {
    const d = eff?.sourceDocument;
    if (d?.object?.center) return d.object.center;
    // Same Number(null)===0 trap as with elevation: without an explicit null
    // check an "unknown location" point would become (0,0) — the top-left corner.
    if (d?.x != null && d?.y != null
        && Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y))) {
      return { x: Number(d.x), y: Number(d.y) };
    }
    for (const uuid of (eff?.data?.masks ?? [])) {
      const m = fromUuidSync?.(String(uuid));
      const o = m?.object ?? m;
      if (o?.center) return o.center;
      if (Number.isFinite(Number(o?.x))) return { x: Number(o.x), y: Number(o.y) };
    }
    // An effect placed by bare coordinates (wall-beam: atLocation({x,y}) + stretchTo) —
    // it has neither a source document nor a mask. The system tags such
    // effects with its template via origin — take the point from there.
    const og = _originDoc(eff);
    if (og?.object?.center) return og.object.center;
    if (Number.isFinite(Number(og?.x))) return { x: Number(og.x), y: Number(og.y) };
    const sp = eff?.sourcePosition;
    if (Number.isFinite(Number(sp?.x)) && Number.isFinite(Number(sp?.y))) {
      return { x: Number(sp.x), y: Number(sp.y) };
    }
  } catch (_e) {}
  return null;
}

/**
 * ⚠️ Number(null) === 0 — not NaN. Because of that "no elevation" turned into
 * "elevation zero": for an effect placed by bare coordinates Sequencer puts
 * elevation: null into the source, and a wall of fire on the second floor was treated as standing on the first —
 * hidden from the one standing next to it and shown one floor below. Check
 * EXPLICITLY for null/undefined before any arithmetic.
 */
function _finiteZ(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Effect elevation: from the tag template, the source document, or the first mask. */
function _effectZ(eff) {
  try {
    // Our own tag first (origin = zone template uuid): for effects placed
    // by coordinates it is the only reliable source.
    //
    // ⚠️ DO NOT ask the effect ITSELF for its elevation, tempting as it is:
    // CanvasEffect.elevation is the draw order, and presets write service
    // values into it ("above everything" = 1000). A second-floor wall would look
    // like an object at elevation 1015 and be hidden from everyone.
    const og = _originDoc(eff);
    const oz = _finiteZ(og?.elevation ?? og?.document?.elevation);
    if (oz !== null) return oz;

    const own = _finiteZ(eff?.sourceDocument?.elevation);
    if (own !== null) return own;

    // Zones are masked to a template — it has an elevation (the system sets it).
    for (const uuid of (eff?.data?.masks ?? [])) {
      const d = fromUuidSync?.(String(uuid));
      const z = _finiteZ(d?.elevation ?? d?.document?.elevation);
      if (z !== null) return z;
    }
  } catch (_e) {}
  return null;                                  // unknown — do not hide
}

/** The floor THIS client is looking at: {bottom, top} or null. */
function _viewerSpan() {
  try {
    const levels = canvas?.scene?.getFlag?.(LEVELS_ID, "sceneLevels");
    const spanFor = (z) => {
      if (!Array.isArray(levels) || !levels.length || !Number.isFinite(z)) return null;
      for (const l of levels) {
        const b = parseFloat(l?.[0]), t = parseFloat(l?.[1]);
        if (Number.isFinite(b) && Number.isFinite(t) && z >= b && z < t) return { bottom: b, top: t };
      }
      return null;
    };
    // 1) The controlled token — the perspective follows it (Levels itself does the same).
    const tok = canvas?.tokens?.controlled?.[0] ?? CONFIG.Levels?.currentToken ?? null;
    if (tok) return spanFor(Number(tok.document?.elevation));
    // 2) Otherwise — the floor selected in the panel.
    const ui = CONFIG.Levels?.UI;
    if (ui?.rangeEnabled && Array.isArray(ui.range)) {
      const b = parseFloat(ui.range[0]), t = parseFloat(ui.range[1]);
      if (Number.isFinite(b) && Number.isFinite(t)) return { bottom: b, top: t };
    }
  } catch (_e) {}
  return null;                                  // unknown — show everything
}

let _applying = false;

function _applyAll() {
  if (_applying) return;
  _applying = true;
  try {
    const EM = (typeof Sequencer !== "undefined") ? Sequencer.EffectManager : null;
    if (!EM || !canvas?.ready) return;
    const span = _viewerSpan();
    // The VIEWER's point and elevation: the controlled token (the perspective follows it), otherwise
    // the Levels perspective. If there is neither — nothing to hide with.
    const _vTok = canvas?.tokens?.controlled?.[0] ?? CONFIG.Levels?.currentToken ?? null;
    const viewPt = _vTok?.center ?? null;
    const viewZ = _vTok ? Number(_vTok.losHeight ?? _vTok.document?.elevation) : NaN;
    for (const eff of (EM.effects ?? [])) {
      try {
        const _show = () => { if (eff.__admFloorHidden) { eff.renderable = true; eff.__admFloorHidden = false; } };
        const z = _effectZ(eff);
        // Elevation unknown — leave it alone: better an extra effect than a missing one.
        if (z === null) { _show(); continue; }

        // ⚠️ Hide only if there REALLY is a ceiling between the viewer and the effect.
        // Previously floors were compared — and a wall of fire in the yard vanished for someone
        // standing on the roof, although there is no ceiling between them and they can see it perfectly well.
        let hide;
        if (_floorSeparates && viewPt && Number.isFinite(viewZ)) {
          // ⚠️ The effect LIES on its own plane, so we lift it by a tiny
          // amount — otherwise the strict inequality does not count the ceiling as "between",
          // and fire on the roof would be visible to someone standing under it inside the house.
          // Tokens need no such correction: their eye height is already above the floor.
          const ePt = _effectPoint(eff);
          const eps = Math.min(1, (Number(canvas?.scene?.grid?.distance) || 5) / 10);
          hide = ePt ? !!_floorSeparates(viewPt, viewZ, ePt, z + eps) : false;
        } else {
          // Fallback rule (no test from the system): same floor.
          if (!span) { _show(); continue; }
          hide = !(z >= span.bottom && z < span.top);
        }
        if (hide) { eff.renderable = false; eff.__admFloorHidden = true; }
        else _show();
      } catch (_e) { /* one effect must not break the whole pass */ }
    }
  } catch (e) { console.warn("[adm-levels] effect floors:", e); }
  finally { _applying = false; }
}

export const TOOL = {
  id: "levelsEffectFloors",
  name: "ADM_LEVELS.settings.levelsEffectFloors.name",
  hint: "ADM_LEVELS.settings.levelsEffectFloors.hint",
  settingScope: "client",   // what to show yourself is a personal matter

  onReady({ isEnabled }) {
    if (!game.modules.get(LEVELS_ID)?.active) return;
    if (typeof Sequencer === "undefined") return;

    _loadFloorTest();   // pull the separation test from the system (lazy import)

    const _run = foundry.utils.debounce(() => { if (isEnabled()) _applyAll(); }, 60);

    // A new effect (and any re-initialization of it goes through the same hook).
    Hooks.on("createSequencerEffect", _run);
    // Floor change: the panel, token selection, a change of its elevation.
    Hooks.on("levelsUiChangeLevel", _run);
    Hooks.on("controlToken", _run);
    // ⚠️ Not only elevation: separation is computed BY POINTS, so a plain step
    // changes the answer too. Entering a house horizontally, the player did not see the wall
    // of flame inside — the recalculation never ran at all, and the only way to bring it back
    // was to deselect the token (not available to a player).
    // A second delayed pass: at the moment of the update the token is still animating, and
    // the viewer's point is the old one.
    Hooks.on("updateToken", (_doc, changes) => {
      const c = changes ?? {};
      if (!("elevation" in c) && !("x" in c) && !("y" in c)) return;
      _run();
      setTimeout(_run, 700);
    });
    // ⚠️ A repeat pass AFTER everything has settled. On joining the game Sequencer
    // replays long-lived effects, and in the first moments their template masks
    // do not resolve yet — the effect elevation is unknown then. In that case the first
    // pass shows everything as it should, but if nobody revisited the decision by the time
    // they resolve, the effect could stay in the wrong state.
    Hooks.on("canvasReady", () => { _run(); setTimeout(_run, 1500); setTimeout(_run, 4000); });

    // Diagnostics: admLevelsEffectFloors() in the console shows what the filter sees.
    globalThis.admLevelsEffectFloors = () => {
      const EM = (typeof Sequencer !== "undefined") ? Sequencer.EffectManager : null;
      const span = _viewerSpan();
      console.info("[adm-levels] viewer floor:", span ?? "undetermined (showing everything)");
      for (const eff of (EM?.effects ?? [])) {
        console.info("  effect:", eff?.data?.file ?? "?",
          "| elevation:", _effectZ(eff),
          "| origin:", eff?.data?.origin ?? "—",
          "| hidden by us:", !!eff.__admFloorHidden,
          "| renderable:", eff.renderable,
          "| ready:", eff.ready);
      }
    };
  },
};
