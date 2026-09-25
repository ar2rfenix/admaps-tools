// scripts/tools/levels-stair-gate.mjs
// ADMaps Tools sub-module: "Disable Levels stairs".
//
// PROBLEM. A Levels stair region is an "Execute Script" behavior
// (executeScript, "token enters" event) whose body is
//   CONFIG.Levels.handlers.RegionHandler.stair(region, event)
// The handler looks at elevation ONLY: matches the top of the range — moves the
// token to the bottom, matches the bottom — moves it to the top. It checks neither
// the movement type nor the player's intent, and it moves via the "displace"
// action — instantly, bypassing the animation and all of our elevation magnets.
//
// This is incompatible with ADMaps Tools: elevation here is owned by OUR OWN regions
// (plateaus, ramp stairs, water), and a foreign handler on top of them produces
// jumps that cannot be explained to the player. Real example: a climbing token at
// 15 ft, dragged over a "Levels Stair 0-15" square, instantly dropped to 0 —
// from the outside it looked like "the token drowned".
//
// SOLUTION. Suppress these handlers entirely. The regions and their behaviors stay
// untouched in the scene: turn the setting off — the old behavior is back. Nothing
// in the world data changes, so there is nothing to clean up afterwards.
//
// ⚠️ The Levels handlers are STATIC class methods that call each other via
// `this`. So the original is invoked via `orig.apply(this, args)`: the wrapper sits
// on the RegionHandler object itself, and without this `this.getRegionEventData` breaks.

const LEVELS_ID = "levels";

/** Levels handlers that move the token in elevation on region entry. */
const BLOCKED = ["stair", "stairUp", "stairDown", "elevator", "updatePendingMovementElevation"];

export const TOOL = {
  id: "levelsStairGate",
  name: "ADM_LEVELS.settings.levelsStairGate.name",
  hint: "ADM_LEVELS.settings.levelsStairGate.hint",
  // A game rule, not a personal view → world setting.

  onReady({ isEnabled }) {
    if (!game.modules.get(LEVELS_ID)?.active) return;
    const RH = CONFIG.Levels?.handlers?.RegionHandler;
    if (!RH) return;

    for (const key of BLOCKED) {
      const orig = RH[key];
      if (typeof orig !== "function" || orig.__admStairBlocked) continue;
      const wrapped = function (...args) {
        if (isEnabled()) {
          // Silently: the "region enter" event fires on every movement step,
          // a warning here would turn into a flood.
          return;
        }
        return orig.apply(this, args);
      };
      wrapped.__admStairBlocked = true;
      RH[key] = wrapped;
    }

    // ── Intervening in region CREATION: silence the SOURCE ───────────────
    // Levels registers its preCreateRegion inside ITS OWN Hooks.on("ready")
    // (levels/scripts/ui.js). Our data restore is also on ready, and core hooks
    // are called in REGISTRATION order (client/helpers/hooks.mjs: the
    // events[hook] array, looped as `entry.fn(...args)`). "adm-levels" loads before
    // "levels", so our restore ran BEFORE the substitution — and the substitution
    // won. Hence the complaint: an ordinary hand-drawn region got the name
    // "Levels Stair X-Y", the color #fe6c0b and a foreign elevation range, even
    // though we were already stripping the script behavior (Levels attaches it
    // deferred, and we did get to it). Restoring "on top" cannot work here at all:
    // as long as their hook is registered after ours, they always have the last word.
    //
    // So we replace their handler IN PLACE: entry.fn is read by core on every
    // call, so the wrapper always runs regardless of registration order. Inside,
    // we silence SELECTIVELY: name, color and the deferred script (all of it
    // behind their stairEnabled flag), while the elevation fill from the panel is
    // kept — it is convenient and is the reason the range gets set. Nothing is
    // removed or deleted: the wrapper asks isEnabled() every time; turn the setting
    // off and Levels works as before.
    const _gateLevelsRegionHook = () => {
      try {
        const entries = Hooks.events?.preCreateRegion;
        if (!Array.isArray(entries)) return false;
        let hit = false;
        for (const entry of entries) {
          const fn = entry?.fn;
          if (typeof fn !== "function" || fn.__admLevelsRegionGate) continue;
          // Their handler is recognized by its body: no other candidate has these markers.
          if (!/Levels Stair|stairEnabled|CONFIG\.Levels\.UI/.test(String(fn))) continue;
          const wrapped = function (region, data, ...rest) {
            if (!isEnabled()) return fn.call(this, region, data, ...rest);
            // Silence ONLY the "stair" part — name, color and the deferred script.
            // All of it sits behind their stairEnabled flag, so for the duration of
            // the call we hand over false and restore it right after (their panel is untouched).
            // The ELEVATION fill from the panel is kept: it is standard, convenient
            // Levels behavior and the reason the range gets set.
            const _ui = CONFIG.Levels?.UI;
            const _stair = _ui?.stairEnabled;
            try { if (_ui) _ui.stairEnabled = false; } catch (_e) {}
            try {
              return fn.call(this, region, data, ...rest);
            } finally {
              try { if (_ui) _ui.stairEnabled = _stair; } catch (_e) {}
              // Elevations: if they WERE in the input data (pasting a set from Mass
              // Edit) — restore them, overwriting the panel fill. Otherwise the whole
              // set would arrive at the current Levels level. A region drawn with
              // the mouse has no elevations in the input data — there the panel is kept.
              try {
                const _e = data?.elevation;
                if (_e && (_e.bottom != null || _e.top != null)) {
                  region.updateSource({ elevation: { bottom: _e.bottom ?? null, top: _e.top ?? null } });
                }
              } catch (_e2) {}
            }
          };
          wrapped.__admLevelsRegionGate = true;
          entry.fn = wrapped;
          hit = true;
        }
        return hit;
      } catch (e) {
        console.warn("[adm-levels] Levels stairs: neutralizing preCreateRegion", e);
        return false;
      }
    };
    // ⚠️ WHEN. Levels registers this hook inside its Hooks.on("ready") (levels/scripts/ui.js), and the tools
    // start on SETUP (main.mjs startTools) — seconds earlier, while the world loads. The old tries (now, +0 ms,
    // +1 s) all came before it, the wrapper never got installed, and a hand-drawn region became «Levels Stair
    // 0-15» in #fe6c0b again (24.09.2026). So: on ready too, and — the sure way — at the moment of creation, from
    // our own preCreateRegion below: it is registered earlier and runs first, and core reads entry.fn at call
    // time (client/helpers/hooks.mjs #call), so their entry is wrapped before it runs. The wrapper is idempotent.
    if (!_gateLevelsRegionHook()) {
      Hooks.once("ready", () => {
        if (_gateLevelsRegionHook()) return;
        setTimeout(_gateLevelsRegionHook, 0);
        setTimeout(_gateLevelsRegionHook, 1000);
      });
    }

    // ── Safety net: restoring region data ────────────────────────────────
    // Kept in case the wrapper above could not be installed (a different Levels
    // version, changed Hooks internals). Works only if our hook ends up AFTER
    // theirs — i.e. on its own it guarantees nothing, but does no harm either.
    // Restores exactly what came in as input.
    // ⚠️ Restores only the fields that WERE in the input data: a region drawn with
    // the mouse has no name or color there, so this path did not undo the Levels
    // substitution — that is why the wrapper appeared.
    Hooks.on("preCreateRegion", (region, data) => {
      try {
        if (!isEnabled()) return;
        _gateLevelsRegionHook(); // their entry, if still bare, is wrapped before core gets to it (see above)
        const upd = {};
        if (data?.name != null && region.name !== data.name) upd.name = data.name;
        if (data?.color != null && region.color !== data.color) upd.color = data.color;
        // Elevations are restored ONLY if they were in the input data (pasting a
        // set from Mass Edit). If not — leave them alone: for a region drawn with
        // the mouse the Levels panel sets the elevations, and that is its standard behavior.
        // ⚠️ Previously this was an unconditional "not in input — so null", which
        // would conflict with the wrapper above and reset the panel range.
        const _de = data?.elevation;
        if (_de && (_de.bottom != null || _de.top != null)) {
          const want = { bottom: _de.bottom ?? null, top: _de.top ?? null };
          const cur = region.elevation ?? {};
          if ((cur.bottom ?? null) !== want.bottom || (cur.top ?? null) !== want.top) upd.elevation = want;
        }
        if (Object.keys(upd).length) region.updateSource(upd);
      } catch (e) { console.warn("[adm-levels] Levels stairs: restoring region data", e); }
    });

    // Levels attaches the script behavior deferred, via its own one-shot hook on
    // createRegion. We strip it after creation — in two passes, because the order
    // of our hooks vs. theirs is not guaranteed here.
    Hooks.on("createRegion", (region) => {
      if (!isEnabled() || !game.user?.isGM) return;
      const strip = async () => {
        try {
          const bad = (region.behaviors ?? []).filter(b =>
            b?.type === "executeScript" && String(b.system?.source ?? "").includes("RegionHandler"));
          if (bad.length) await region.deleteEmbeddedDocuments("RegionBehavior", bad.map(b => b.id));
        } catch (e) { console.warn("[adm-levels] Levels stairs: stripping script behavior", e); }
      };
      strip();
      setTimeout(strip, 300);
    });

    // Once per scene, report to the console that it contains such regions —
    // otherwise the GM will be hunting for why a drawn stair "does not work".
    const _reportScene = () => {
      if (!game.user?.isGM || !isEnabled()) return;
      try {
        const names = [];
        for (const r of (canvas?.scene?.regions ?? [])) {
          for (const b of (r.behaviors ?? [])) {
            if (b.type !== "executeScript" || b.disabled) continue;
            if (!String(b.system?.source ?? "").includes("RegionHandler")) continue;
            names.push(r.name || r.id);
            break;
          }
        }
        if (names.length) {
          console.info("[adm-levels] Levels stair scripts are disabled by the setting; regions on this scene:", names.join(", "));
        }
      } catch (_e) { /* diagnostics must not get in the way */ }
    };
    Hooks.on("canvasReady", _reportScene);
    _reportScene();
  },
};
