// modules/admaps-background-freeze/scripts/main.mjs
// ADMaps Background Freeze — freeze / resume the animated scene background video,
// showing the SAME frame on every client.
//
// The GM toggles the freeze from a button in the tiles toolbar. The state is
// stored as Scene flags, so Foundry broadcasts it to every client through the
// standard document update — reconnecting players and scene switches pick up the
// current state on canvasReady. No manual socket needed.
//
// Frame sync:
//   Background videos play independently on each client (everyone loads at a
//   different time), so without help each client would freeze on its own frame.
//   On freeze the GM records its current video time into a flag; every client
//   seeks its video to that exact time before freezing, so all clients show the
//   GM's frame.
//
// Why we override play():
//   Foundry re-plays scene videos on every canvas refresh (_refreshVideo ->
//   game.video.play -> video.play()), so a plain pause() unfreezes within ~1s.
//   While frozen we neutralize the element's play() so any refresh-driven
//   auto-resume becomes a no-op. Restored on unfreeze.
//
// Why baseTexture.update() after seeking:
//   PIXI removes a video from its update ticker when the element is paused, so a
//   seek on a paused video never reaches the GPU texture (the old frame stays on
//   screen). After the seek lands we force a one-shot texture upload so the
//   GM's frame actually appears.

const MODULE_ID = "admaps-background-freeze";

// ⚠️ getFlag/setFlag/unsetFlag with the namespace of a REMOVED module throw "scope not valid or not active".
// We access the flags DIRECTLY (data under the old namespace is intact; same behavior, minus the scope validation).
const _flagGet = (doc, ns, key) => foundry.utils.getProperty(doc?.flags ?? {}, `${ns}.${key}`);
const _flagSet = (doc, ns, key, val) => doc.update({ [`flags.${ns}.${key}`]: val });
const _flagDel = (doc, ns, key) => doc.update({ [`flags.${ns}.-=${key}`]: null });

const FLAG_FROZEN = "frozen";
const FLAG_TIME = "time";

/* ───────── Video helpers ───────── */

// Return the <video> element backing a canvas object's texture, if any.
// Mirrors Foundry's own VideoHelper.getVideoSource (tagName check).
function _getVideo(obj) {
  const src = obj?.texture?.baseTexture?.resource?.source;
  return (src?.tagName === "VIDEO") ? src : null;
}

// Collect { mesh, video } for the scene background / foreground. Falls back to
// the first video mesh in the primary group (covers a background built as a
// single video tile) — mirrors the tested macro. We keep the mesh because the
// frame-sync path needs its baseTexture to force a GPU upload.
function _collectBackgroundEntries() {
  const out = [];
  const seen = new Set();
  const add = (mesh) => {
    const video = _getVideo(mesh);
    if (video && !seen.has(video)) { seen.add(video); out.push({ mesh, video }); }
  };

  add(canvas?.primary?.background);
  add(canvas?.primary?.foreground);

  if (!out.length) {
    for (const child of (canvas?.primary?.children ?? [])) {
      if (_getVideo(child)) { add(child); break; }
    }
  }
  return out;
}

// Force PIXI to re-upload the mesh's current video frame to the GPU. Needed
// after seeking a paused video (PIXI stops auto-updating the texture on pause).
function _forceFrame(mesh) {
  try { mesh?.texture?.baseTexture?.update(); } catch (_e) {}
}

// Freeze one entry: optionally seek to `time` (the GM's frame), then pause and
// neutralize play() so refresh-driven auto-resume cannot restart it. Guarded
// against double-freeze (which would lose the real play() reference).
function _freezeEntry({ mesh, video }, time) {
  if (!video || video.__admBgFrozen) return;
  video.__admBgRealPlay = video.play.bind(video);
  video.play = () => Promise.resolve();
  video.__admBgFrozen = true;

  // Pause + show the held frame (after a seek, re-upload it to the GPU).
  const hold = () => {
    try { video.pause(); } catch (_e) {}
    _forceFrame(mesh);
  };

  const wantSeek = Number.isFinite(time) && time >= 0
    && Math.abs((Number(video.currentTime) || 0) - time) > 0.001;

  if (!wantSeek) { hold(); return; }

  // Seek to the GM's frame, then hold once the frame is decoded. setTimeout is a
  // safety net in case 'seeked' never fires for this element.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    video.removeEventListener("seeked", finish);
    hold();
  };
  video.addEventListener("seeked", finish);
  try { video.currentTime = time; } catch (_e) { finish(); }
  setTimeout(finish, 500);
}

// Unfreeze one entry: restore play() and resume playback.
function _unfreezeEntry({ video }) {
  if (!video || !video.__admBgFrozen) return;
  if (video.__admBgRealPlay) {
    video.play = video.__admBgRealPlay;
    video.__admBgRealPlay = null;
  }
  video.__admBgFrozen = false;
  try { video.play().catch(() => {}); } catch (_e) {}
}

// Apply the desired frozen state (+ synced frame time) to all background videos.
function _applyFreezeState(frozen, time) {
  for (const entry of _collectBackgroundEntries()) {
    if (frozen) _freezeEntry(entry, time);
    else _unfreezeEntry(entry);
  }
}

// Read the active scene's freeze state / synced frame time from its flags.
function _isSceneFrozen() {
  return !!_flagGet(canvas?.scene, MODULE_ID, FLAG_FROZEN);
}
function _sceneFreezeTime() {
  const t = _flagGet(canvas?.scene, MODULE_ID, FLAG_TIME);
  return Number.isFinite(t) ? Number(t) : 0;
}

/* ───────── GM toggle ───────── */

// Toggle the freeze on the active scene (GM only). On freeze we record the GM's
// current frame time so every client syncs to it. Both flags are written in one
// update so clients apply an atomic, consistent state.
async function _toggleFreeze() {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Only the GM can freeze the background.");
    return;
  }
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications?.warn("No active scene.");
    return;
  }
  const entries = _collectBackgroundEntries();
  if (!entries.length) {
    ui.notifications?.warn("No animated video background on this scene.");
    return;
  }

  const next = !_isSceneFrozen();
  // Capture the GM's current frame (primary background video) for the sync.
  const time = next ? (Number(entries[0]?.video?.currentTime) || 0) : 0;

  await scene.update({
    [`flags.${MODULE_ID}.${FLAG_FROZEN}`]: next,
    [`flags.${MODULE_ID}.${FLAG_TIME}`]: time,
  });

  ui.notifications?.info(next
    ? "Background video frozen for all players (synced frame)."
    : "Background video resumed for all players.");
}

/* ───────── ADMaps Tools sub-module descriptor ───────── */

export const TOOL = {
  id: "backgroundFreeze",
  name: "ADM_LEVELS.settings.backgroundFreeze.name",
  hint: "ADM_LEVELS.settings.backgroundFreeze.hint",
  replaces: ["admaps-background-freeze"],

  onReady({ isEnabled }) {
    // "Freeze background" button in the tiles tools (GM only).
    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM) return;
      const tools = controls?.tiles?.tools;
      if (!tools) return;
      tools.admapsBackgroundFreeze = {
        name: "admapsBackgroundFreeze",
        title: "Freeze Background Video",
        icon: "fas fa-snowflake",
        button: true,
        onChange: () => _toggleFreeze(),
      };
    });
    // Apply the freeze state on every canvas (re)draw.
    Hooks.on("canvasReady", () => {
      if (!isEnabled()) return;
      _applyFreezeState(_isSceneFrozen(), _sceneFreezeTime());
    });
    // React to the GM toggling the flag — apply on every client viewing this scene.
    Hooks.on("updateScene", (scene, changed) => {
      if (!isEnabled()) return;
      if (scene.id !== canvas?.scene?.id) return;
      if (!foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) return;
      _applyFreezeState(_isSceneFrozen(), _sceneFreezeTime());
    });
  },
};
