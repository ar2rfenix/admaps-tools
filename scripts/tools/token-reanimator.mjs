/* -------------------------------------------------------------------------------------------------
 * ADMaps Token Reanimator (FVTT v13)
 * Author: ADMaps
 *
 * Purpose:
 * - Ensure PIXI shared ticker stays running (some modules stop it).
 * - Resume all WEBM/VIDEO sources found on the canvas (tiles, weather, Sequencer-like effects, etc.).
 * - Trigger revival after token updates (commonly happens when adding rings/overlays),
 *   after canvasReady, and after scene activation.
 * - Optional periodic guard to re-enable ticker and resume paused videos.
 * ------------------------------------------------------------------------------------------------- */

const MODULE_ID = "admaps-token-reanimator";

let _intervalId = null;
let _debounceId = null;
let _deepVids = new Set();    // videos found by the deep stage scan (weather, effects, custom containers)
let _guardTicks = 0;
let _sceneHasVideos = false;  // last scan verdict: scene has no videos → token hooks are no-ops
let _isEnabled = () => true;  // sub-module checkbox (set in onReady)
const DEEP_RESCAN_EVERY = 15; // deep rescan every N guard ticks (15 × 2s = ~30s)

function log(...args) {
  if (!game?.settings?.get("adm-levels", "tokenReanimator.debug")) return;
  console.log(`[${MODULE_ID}]`, ...args);
}

function ensureTickers() {
  try {
    // Foundry's app ticker
    if (canvas?.app?.ticker && !canvas.app.ticker.started) {
      canvas.app.ticker.start();
      log("canvas.app.ticker.start()");
    }
    if (canvas?.app?.ticker) canvas.app.ticker.speed = 1;

    // PIXI shared ticker (critical for video updates in many setups)
    if (PIXI?.Ticker?.shared && !PIXI.Ticker.shared.started) {
      PIXI.Ticker.shared.start();
      log("PIXI.Ticker.shared.start()");
    }
  } catch (e) {
    // Intentionally silent
  }
}

function _addVideoFrom(obj, vids) {
  const v = obj?.texture?.baseTexture?.resource?.source;
  if (v?.tagName === "VIDEO") vids.add(v);
}

/**
 * Deep recursive scan of the whole stage (weather, Sequencer, custom containers).
 * EXPENSIVE on big scenes (thousands of nodes, ~8ms main-thread block) — so it
 * runs rarely (scene load + every ~30s in the guard) and the result is cached.
 */
function deepScanVideos() {
  const vids = new Set();
  try {
    const scan = (container) => {
      if (!container?.children) return;
      for (const ch of container.children) {
        _addVideoFrom(ch, vids);
        scan(ch);
      }
    };
    scan(canvas?.stage);
  } catch (e) {
    // Intentionally silent
  }
  _deepVids = vids;
  return vids;
}

function collectVideos() {
  const vids = new Set();

  try {
    // Cheap targeted pass: tiles + token art are where paused WEBMs actually
    // appear (ring/overlay application). O(tiles + tokens), no stage walk.
    for (const t of canvas?.tiles?.placeables ?? []) {
      _addVideoFrom(t, vids);
      _addVideoFrom(t.mesh, vids);
    }
    for (const t of canvas?.tokens?.placeables ?? []) {
      _addVideoFrom(t.mesh, vids);
    }

    // Union with the cached deep-scan results (refreshed rarely).
    // NOTE: PIXI video elements live detached from DOM — do not filter by isConnected.
    for (const v of _deepVids) vids.add(v);
  } catch (e) {
    // Intentionally silent
  }

  _sceneHasVideos = vids.size > 0;
  return vids;
}

async function resumeVideos(vids) {
  for (const v of vids) {
    try {
      // Keep autoplay-friendly state
      v.loop = true;
      v.muted = true;
      v.playbackRate = 1;

      // If video is paused, attempt to resume
      if (v.paused) {
        await v.play();
        log("video.play()", v.currentSrc || v.src || "(unknown)");
      }
    } catch (e) {
      // Autoplay policies or user gesture restrictions can throw; ignore
      log("video.play() failed", e?.message || e);
    }
  }
}

async function reviveNow(reason = "unknown") {
  if (!_isEnabled()) return;   // sub-module checkbox (live)
  if (!canvas?.ready) return;

  ensureTickers();

  // Scene (re)load — the one moment a deep scan is warranted: pick up
  // weather/effect videos into the cache.
  if (reason === "canvasReady" || reason === "updateScene(active)") deepScanVideos();

  const vids = collectVideos();
  log(`reviveNow(${reason}) videos=${vids.size}`);

  await resumeVideos(vids);
}

function reviveDebounced(reason = "debounced") {
  const delayMs = Math.max(0, Number(game.settings.get("adm-levels", "tokenReanimator.debounceMs") || 0));

  if (_debounceId) clearTimeout(_debounceId);
  _debounceId = setTimeout(() => reviveNow(reason), delayMs);
}

function shouldGuardTick() {
  try {
    if (PIXI?.Ticker?.shared && !PIXI.Ticker.shared.started) return true;

    // Lightweight check: if any collected video is paused, try to revive
    const vids = collectVideos();
    for (const v of vids) {
      if (v?.tagName === "VIDEO" && v.paused) return true;
    }
  } catch (e) {
    // Intentionally silent
  }
  return false;
}

function startGuardInterval() {
  stopGuardInterval();

  const seconds = Number(game.settings.get("adm-levels", "tokenReanimator.guardIntervalSec") || 0);
  if (!seconds || seconds <= 0) return;

  _intervalId = setInterval(() => {
    if (!_isEnabled()) return;   // sub-module checkbox (live)
    if (!canvas?.ready) return;

    // Periodic deep rescan keeps the cache aware of effects created mid-session.
    if (++_guardTicks % DEEP_RESCAN_EVERY === 0) deepScanVideos();

    if (shouldGuardTick()) {
      reviveNow("guard-interval");
    }
  }, Math.max(250, seconds * 1000));

  log("Guard interval started", seconds);
}

function stopGuardInterval() {
  if (_intervalId) clearInterval(_intervalId);
  _intervalId = null;
}

export const TOOL = {
  id: "tokenReanimator",
  name: "ADM_LEVELS.settings.tokenReanimator.name",
  hint: "ADM_LEVELS.settings.tokenReanimator.hint",
  replaces: ["admaps-token-reanimator"],

  // Tuning settings — hidden from the panel (config:false), sensible defaults; namespace adm-levels.
  onInit() {
    const NS = "adm-levels";
    game.settings.register(NS, "tokenReanimator.guardIntervalSec", { scope: "world", config: false, type: Number, default: 2 });
    game.settings.register(NS, "tokenReanimator.debounceMs", { scope: "world", config: false, type: Number, default: 150 });
    game.settings.register(NS, "tokenReanimator.runOnTokenChanges", { scope: "world", config: false, type: Boolean, default: true });
    game.settings.register(NS, "tokenReanimator.debug", { scope: "client", config: false, type: Boolean, default: false });
  },

  onReady({ isEnabled }) {
    _isEnabled = isEnabled;
    const runTok = () => game.settings.get("adm-levels", "tokenReanimator.runOnTokenChanges");

    // After a full reload bring up the guard (a no-op by itself when the checkbox is off — reviveNow is gated).
    startGuardInterval();

    Hooks.on("canvasReady", () => {
      if (!isEnabled()) return;
      reviveDebounced("canvasReady");
      startGuardInterval();
    });
    Hooks.on("updateScene", (scene, data) => {
      if (!isEnabled()) return;
      if ("active" in data) { reviveDebounced("updateScene(active)"); startGuardInterval(); }
    });
    Hooks.on("updateToken", () => {
      if (!isEnabled() || !runTok() || !_sceneHasVideos) return;
      reviveDebounced("updateToken");
    });
    Hooks.on("refreshToken", () => {
      if (!isEnabled() || !runTok() || !_sceneHasVideos) return;
      reviveDebounced("refreshToken");
    });
    Hooks.on("destroyCanvas", () => {
      stopGuardInterval();
      _deepVids = new Set(); // drop refs to the old scene's video elements
    });
  },
};
