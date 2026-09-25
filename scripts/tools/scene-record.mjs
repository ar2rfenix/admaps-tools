// modules/adm-levels/scripts/tools/scene-record.mjs
// ADMaps Tools — «Scene recording».
// Right-click a scene in the navbar (active scene only, GM) → «Record scene» item. We fit
// the zoom so the scene fills the viewport as much as possible (contain — the larger side
// flush with the edge), record the canvas for the time set in settings and save into Foundry's data folder.
//
// Why there is no UI in the recording: Foundry's UI is separate HTML above the canvas; the WebGL
// canvas draws ONLY the scene (background/tiles/tokens/lighting/FX/scroll shader). captureStream
// of the canvas = picture WITHOUT the interface.
//
// Cropping to the scene bounds: after the fit the scene is centered in the viewport, but when the
// window and scene aspects differ (e.g. window 16:10, scene 16:9) black bars remain. To record
// EXACTLY the scene area without bars, we pipe the canvas stream through a <video> and cut out
// the central scene area onto a crop canvas (`_startCroppedCapture`), and record that instead.

const MODULE_ID = "adm-levels";
const SETTING_DURATION = "sceneRecord.duration";
const SETTING_AUDIO = "sceneRecord.audio";
const REC_DIR = "adm-scene-recordings";

// The cinematic camera during recording is NOT here: it lived in the «ADMaps Cinema» sub-tool
// (tools/cinema.mjs), which is HIDDEN — not in the registry's TOOLS array, the file itself
// is still in place. Recording is unaffected: it frames the shot itself (_fitSceneToView +
// crop to the scene bounds); the black bars are cut off by the crop, not by the camera.

let _busy = false;

const _FP = () => (foundry.applications?.apps?.FilePicker ?? FilePicker);

function _pickVideoMime() {
  // VP9 first: editing suites can't digest AV1-in-WebM (Premiere and the
  // «WebM for Premiere» plugin only handle VP8/VP9 — AV1 broke frame by frame).
  const cands = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm;codecs=av01",
    "video/webm",
    "video/mp4",
  ];
  for (const m of cands) { try { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; } catch { /* noop */ } }
  return "";
}

function _stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Fit the camera: the whole scene is visible and fills the viewport as much as possible (contain
// by the scene bounds WITHOUT padding). The larger side is flush with the screen edge.
async function _fitSceneToView() {
  const dims = canvas.dimensions;
  const rect = dims.sceneRect ?? { x: dims.sceneX, y: dims.sceneY, width: dims.sceneWidth, height: dims.sceneHeight };
  const [sw, sh] = canvas.screenDimensions;
  const fit = Math.min(sw / rect.width, sh / rect.height);
  const scale = Math.max(CONFIG.Canvas.minZoom ?? 0.05, Math.min(CONFIG.Canvas.maxZoom ?? 3, fit));
  await canvas.animatePan({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scale, duration: 300 });
}

// Save the blob into Foundry's data folder (creates the directory if needed). Fallback — download.
async function _saveRecording(blob, ext, sceneName) {
  const safe = String(sceneName || "scene").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "scene";
  const name = `${safe}-${_stamp()}.${ext}`;
  const FP = _FP();
  try {
    try { await FP.createDirectory("data", REC_DIR); } catch { /* already exists */ }
    const file = new File([blob], name, { type: blob.type });
    const res = await FP.upload("data", REC_DIR, file, {}, { notify: false });
    if (res?.path) { ui.notifications?.info(game.i18n.format("ADM_LEVELS.sceneRecord.saved", { path: res.path })); return; }
    ui.notifications?.warn(game.i18n.format("ADM_LEVELS.sceneRecord.maybeNotSaved", { path: `${REC_DIR}/${name}` }));
  } catch (e) {
    console.error("[ADM:sceneRecord] upload failed, fallback to download:", e);
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, 5000);
      ui.notifications?.info(game.i18n.format("ADM_LEVELS.sceneRecord.downloaded", { name }));
    } catch (e2) {
      console.error("[ADM:sceneRecord] download fallback failed:", e2);
      ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.saveFailed"));
    }
  }
}

// Open the crop source: canvas → <video> (plays the captureStream) → crop canvas
// (we cut out the central scene area — no black bars when the window and scene aspects
// differ). The intermediate <video> removes the empty-WebGL-buffer problem of a direct
// drawImage(canvas) without preserveDrawingBuffer. Shared part of both recording paths (MP4/webm).
// Call AFTER _fitSceneToView() (needs the final scale of the centered scene).
async function _openCropSource(view, fps) {
  const dims = canvas.dimensions;
  const rect = dims.sceneRect ?? { x: dims.sceneX, y: dims.sceneY, width: dims.sceneWidth, height: dims.sceneHeight };
  const [sw, sh] = canvas.screenDimensions;
  const scale = canvas.stage?.scale?.x || 1;
  // Fraction of the viewport occupied by the scene after the contain-fit (scene centered by the pan).
  // The fractions are the same in CSS and buffer pixels (buffer = CSS × resolution — uniform scale),
  // so they apply directly to the captureStream buffer frame.
  const fracW = Math.min(1, (rect.width * scale) / sw);
  const fracH = Math.min(1, (rect.height * scale) / sh);
  const fracX = (1 - fracW) / 2;
  const fracY = (1 - fracH) / 2;

  const sourceStream = view.captureStream(fps);
  // Frames WITHOUT a hidden <video>: MediaStreamTrackProcessor hands out the capture's
  // VideoFrames directly — we keep the LATEST one and close the previous. The old <video>
  // path added its own frame-delivery delay: the picture lagged behind the audio
  // (which runs on the wall-clock) by a constant few seconds. <video> remains as a fallback
  // for environments without MSTP (a Firefox player on the webm path).
  let latestFrame = null;
  let srcStopped = false;
  let frameReader = null;
  let video = null;
  let vw = 0, vh = 0;
  const _bail = (msg) => {
    srcStopped = true;
    try { frameReader?.cancel?.(); } catch { /* noop */ }
    if (latestFrame) { try { latestFrame.close(); } catch { /* noop */ } latestFrame = null; }
    try { sourceStream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { video?.remove?.(); } catch { /* noop */ }
    // The caller falls back to full-viewport capture (working, though with bars) —
    // better than recording a black crop.
    throw new Error(msg);
  };
  if (typeof MediaStreamTrackProcessor === "function" && typeof VideoFrame === "function") {
    frameReader = new MediaStreamTrackProcessor({ track: sourceStream.getVideoTracks()[0] }).readable.getReader();
    (async () => {
      while (!srcStopped) {
        let r;
        try { r = await frameReader.read(); } catch { break; }
        if (r?.done) break;
        const prev = latestFrame;
        latestFrame = r.value;
        if (prev) { try { prev.close(); } catch { /* noop */ } }
      }
    })();
    for (let i = 0; i < 120 && !latestFrame; i++) await new Promise((r) => setTimeout(r, 16));
    if (!latestFrame) _bail("scene-record: capture produced no frames (MSTP)");
    vw = latestFrame.codedWidth;
    vh = latestFrame.codedHeight;
  } else {
    video = document.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.srcObject = sourceStream;
    video.style.cssText = "position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
    try { await video.play(); } catch { /* MediaStream autoplay is usually fine */ }
    // Wait for the real frame dimensions (up to ~2 s).
    for (let i = 0; i < 120 && !(video.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 16));
    if (!(video.videoWidth > 0)) _bail("scene-record: <video> produced no frames");
    vw = video.videoWidth;
    vh = video.videoHeight;
  }

  const sx = Math.max(0, Math.round(fracX * vw));
  const sy = Math.max(0, Math.round(fracY * vh));
  const srcW = Math.max(2, Math.round(fracW * vw));
  const srcH = Math.max(2, Math.round(fracH * vh));
  const outW = Math.max(2, srcW) & ~1;   // even dimensions — an encoder requirement
  const outH = Math.max(2, srcH) & ~1;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = outW; cropCanvas.height = outH;
  const cctx = cropCanvas.getContext("2d", { alpha: false });

  // Dice So Nice dice — a SEPARATE WebGL canvas above the scene (absent from the scene
  // canvas's captureStream). Readable via drawImage only with their own user flag
  // preserveDrawingBuffer (DSN keeps it precisely for capture; without the flag the buffer
  // is empty after compositing). The DSN renderer's alpha is real — the dice overlay on top.
  // ⚠️ #dice-box-canvas is the DIV CONTAINER, the <canvas> itself is inside it; the container
  // may NOT be full-screen (configurable rollingArea) and fades after the roll
  // (opacity → display:none). So we map through the canvas's actual rectangle
  // (CSS) → intersection with the crop area, and mix the container's opacity
  // into globalAlpha — the dice fade in the recording as on screen.
  const _dsnOk = !!game.modules?.get?.("dice-so-nice")?.active
    && !!game.user?.getFlag?.("dice-so-nice", "preserveDrawingBuffer");
  // Crop area in window CSS pixels (fractions are the same in CSS and buffer).
  const cropX = fracX * sw, cropY = fracY * sh, cropW = fracW * sw, cropH = fracH * sh;
  // We do NOT read the dice geometry from layout (getBoundingClientRect/getComputedStyle
  // every frame = forced reflow 60 times/s, slowed the whole client). We take
  // only cheap INLINE styles: the container's left/top (0 with the default full-screen
  // area), the canvas CSS size (three.js writes it into style on setSize),
  // display:none after the fade — stop drawing (the preserve buffer keeps
  // the last frame; freezing it into the recording is not acceptable).
  const drawFrame = () => {
    const fsrc = latestFrame ?? video;
    if (fsrc) { try { cctx.drawImage(fsrc, sx, sy, srcW, srcH, 0, 0, outW, outH); } catch { /* frame not ready — skip it */ } }
    if (!_dsnOk) return;
    try {
      const wrap = document.getElementById("dice-box-canvas");
      if (!wrap || wrap.style.display === "none") return;
      const op = wrap.style.opacity === "" ? 1 : (parseFloat(wrap.style.opacity) || 0);
      if (op <= 0.01) return;
      const dsn = wrap.querySelector("canvas");
      if (!dsn || !(dsn.width > 1)) return;
      const rl = parseFloat(wrap.style.left) || 0;
      const rt = parseFloat(wrap.style.top) || 0;
      const rw = parseFloat(dsn.style.width) || dsn.width;
      const rh = parseFloat(dsn.style.height) || dsn.height;
      const ix1 = Math.max(rl, cropX), iy1 = Math.max(rt, cropY);
      const ix2 = Math.min(rl + rw, cropX + cropW), iy2 = Math.min(rt + rh, cropY + cropH);
      if (ix2 - ix1 < 1 || iy2 - iy1 < 1) return; // dice outside the frame
      const kx = dsn.width / rw, ky = dsn.height / rh;
      const ox = outW / cropW, oy = outH / cropH;
      const prevAlpha = cctx.globalAlpha;
      cctx.globalAlpha = op;
      cctx.drawImage(dsn,
        (ix1 - rl) * kx, (iy1 - rt) * ky, (ix2 - ix1) * kx, (iy2 - iy1) * ky,
        (ix1 - cropX) * ox, (iy1 - cropY) * oy, (ix2 - ix1) * ox, (iy2 - iy1) * oy);
      cctx.globalAlpha = prevAlpha;
    } catch { /* noop */ }
  };
  drawFrame(); // first frame — so the recording doesn't start black

  const stopSource = () => {
    srcStopped = true;
    try { frameReader?.cancel?.(); } catch { /* noop */ }
    if (latestFrame) { try { latestFrame.close(); } catch { /* noop */ } latestFrame = null; }
    try { sourceStream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    if (video) { try { video.pause(); video.srcObject = null; video.remove(); } catch { /* noop */ } }
  };
  return { cropCanvas, outW, outH, drawFrame, stopSource };
}

/** Tap the audio of the «Environment» + «Interface» channels (NOT music) into one audio track.
 *  In v13 each channel is its own AudioContext with a master gainNode (volume slider)
 *  before the destination; we attach a PARALLEL branch gainNode →
 *  MediaStreamDestination: the recording gets exactly what is heard, playback is
 *  untouched. A foreign context is bridged via its own MediaStreamDestination → source
 *  in the mixer context. Returns { track, sampleRate, stop } or null. */
function _openGameAudioTap() {
  try {
    const chans = [game.audio?.environment, game.audio?.interface].filter((c) => c?.gainNode);
    if (!chans.length) return null;
    const mixCtx = chans[0];
    const dest = mixCtx.createMediaStreamDestination();
    const cleanups = [];
    for (const ctx of chans) {
      if (ctx === mixCtx) {
        ctx.gainNode.connect(dest);
        cleanups.push(() => { try { ctx.gainNode.disconnect(dest); } catch { /* noop */ } });
      } else {
        const bridge = ctx.createMediaStreamDestination();
        ctx.gainNode.connect(bridge);
        const srcNode = mixCtx.createMediaStreamSource(bridge.stream);
        srcNode.connect(dest);
        cleanups.push(() => {
          try { ctx.gainNode.disconnect(bridge); } catch { /* noop */ }
          try { srcNode.disconnect(dest); } catch { /* noop */ }
        });
      }
    }
    const track = dest.stream.getAudioTracks()[0] ?? null;
    if (!track) { for (const f of cleanups) f(); return null; }
    return {
      track,
      sampleRate: mixCtx.sampleRate,
      stop: () => { try { track.stop(); } catch { /* noop */ } for (const f of cleanups) f(); },
    };
  } catch (e) {
    console.warn("[ADM:sceneRecord] audio tap:", e);
    return null;
  }
}

// Path 2 (fallback): crop canvas → captureStream → MediaRecorder (webm).
async function _startCroppedCapture(view, fps) {
  const src = await _openCropSource(view, fps);
  const { cropCanvas, outW, outH } = src;
  let raf = 0, stopped = false, outStream;
  const draw = () => {
    if (stopped) return;
    src.drawFrame();
    raf = requestAnimationFrame(draw);
  };
  // stop is defined BEFORE captureStream and with `outStream?.` — so rAF/stream/video get cleaned up even
  // if captureStream below throws (otherwise the rAF loop would be orphaned with no way to cancel it).
  const stop = () => {
    stopped = true;
    try { cancelAnimationFrame(raf); } catch { /* noop */ }
    try { outStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    src.stopSource();
  };
  raf = requestAnimationFrame(draw);
  try {
    outStream = cropCanvas.captureStream(fps);
  } catch (e) {
    stop();
    throw e;
  }
  return { stream: outStream, stop, outW, outH };
}

// Path 1: record DIRECTLY into an edit-ready MP4 via WebCodecs. Hardware H.264, frame
// timestamps are set by us — true CFR by construction (missed ticks = duplicate
// frames), container with an index (mp4-muxer, MIT — scripts/libs/). Editing suites choke
// on MediaRecorder webm: VFR, no Cues/Duration — Premiere crashed both on import (AV1) and
// on render («Unable to produce frame»). The module CANNOT spawn an external ffmpeg:
// the Foundry renderer has no nodeIntegration.
async function _startMp4Capture(view, fps, durationSec, audioTap = null) {
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") {
    throw new Error("scene-record: WebCodecs unavailable");
  }
  const { Muxer, ArrayBufferTarget } = await import("../libs/mp4-muxer.min.mjs");
  const src = await _openCropSource(view, fps);
  const { cropCanvas, outW, outH } = src;

  // Quality: ~0.2 bits/pixel·frame (1080p60 ≈ 25 Mbit/s), ceiling 100 Mbit/s.
  // Duration cap: the file is assembled IN MEMORY (fastStart in-memory) — keep the
  // expected size ≤ ~1.2 GB, otherwise finalize of a long recording hits OOM/RangeError
  // (buffer growth by doubling + slice + Blob = a peak several times the file itself).
  const _memCapBps = Math.round(1.2e9 * 8 / Math.max(1, durationSec || 15));
  const bitrate = Math.min(100_000_000, _memCapBps, Math.max(8_000_000, Math.round(outW * outH * fps * 0.2)));
  // Profile/level for the frame size: first supported one (High 5.1 → 4.2 → 4.0 → Main 5.1).
  let codec = null;
  for (const c of ["avc1.640033", "avc1.64002a", "avc1.640028", "avc1.4d0033"]) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c, width: outW, height: outH, bitrate, framerate: fps });
      if (r?.supported) { codec = c; break; }
    } catch { /* try the next one */ }
  }
  if (!codec) { src.stopSource(); throw new Error("scene-record: H.264 encoding not supported"); }

  // Audio («Environment»+«Interface» tap): AAC if the encoder supports it (native for
  // Premiere), otherwise Opus; if neither is available — record without audio.
  let aCfg = null;
  if (audioTap?.track && typeof AudioEncoder === "function" && typeof MediaStreamTrackProcessor === "function") {
    for (const c of [{ codec: "mp4a.40.2", mux: "aac" }, { codec: "opus", mux: "opus" }]) {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: audioTap.sampleRate, numberOfChannels: 2, bitrate: 160_000 });
        if (r?.supported) { aCfg = c; break; }
      } catch { /* try the next one */ }
    }
    if (!aCfg) console.warn("[ADM:sceneRecord] audio encoder unavailable (AAC/Opus) — recording without audio");
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: outW, height: outH, frameRate: fps },
    ...(aCfg ? { audio: { codec: aCfg.mux, sampleRate: audioTap.sampleRate, numberOfChannels: 2 } } : {}),
    fastStart: "in-memory",
  });
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encError = encError ?? e; } },
    error: (e) => { encError = encError ?? e; },
  });

  // Audio pipeline: errors are NOT fatal — we mute the audio and finish the video (a clip
  // without audio beats a lost clip). MediaStreamTrackProcessor reads AudioData
  // from the tap track, AudioEncoder encodes, the muxer assembles.
  let aEncoder = null, aReader = null, aFirstTs = null, aDead = false;
  const _stopAudio = () => {
    aDead = true;
    try { aReader?.cancel?.(); } catch { /* noop */ }
    try { aEncoder?.close?.(); } catch { /* noop */ }
  };
  if (aCfg) {
    aEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          // Normalize to zero: the muxer requires the track to start at 0, while AudioData
          // timestamps count from the capture start, not the clip start.
          if (aFirstTs == null) aFirstTs = chunk.timestamp;
          muxer.addAudioChunk(chunk, meta, chunk.timestamp - aFirstTs);
        } catch (e) { console.warn("[ADM:sceneRecord] audio mux:", e); _stopAudio(); }
      },
      error: (e) => { console.warn("[ADM:sceneRecord] audio encoder:", e); _stopAudio(); },
    });
    try {
      aEncoder.configure({ codec: aCfg.codec, sampleRate: audioTap.sampleRate, numberOfChannels: 2, bitrate: 160_000 });
      // maxBufferSize ~4 s: reading happens on the main thread — when it janks
      // (attacks/animations) the default short queue DROPPED AudioData.
      aReader = new MediaStreamTrackProcessor({ track: audioTap.track, maxBufferSize: 400 }).readable.getReader();
      let expectTs = null; // expected timestamp of the next AudioData (µs)
      (async () => {
        while (!aDead) {
          let r;
          try { r = await aReader.read(); } catch { break; }
          if (r?.done) break;
          const ad = r.value;
          try {
            if (!aDead) {
              // Dropped AudioData WITHOUT compensation compressed the audio timeline:
              // the encoder stamps output by the sample counter, so every drop shifted
              // all subsequent audio EARLIER (cumulative desync «after every
              // attack»). We plug the gaps with silence — the timeline no longer shrinks.
              if (expectTs != null) {
                const gapUs = ad.timestamp - expectTs;
                if (gapUs > 20000) {
                  const gapFrames = Math.min(audioTap.sampleRate * 5, Math.round(gapUs * audioTap.sampleRate / 1e6));
                  const silent = new AudioData({
                    format: "f32-planar", sampleRate: audioTap.sampleRate,
                    numberOfFrames: gapFrames, numberOfChannels: ad.numberOfChannels,
                    timestamp: expectTs, data: new Float32Array(gapFrames * ad.numberOfChannels),
                  });
                  try { aEncoder.encode(silent); } finally { try { silent.close(); } catch { /* noop */ } }
                }
              }
              expectTs = ad.timestamp + Math.round(ad.numberOfFrames * 1e6 / ad.sampleRate);
              aEncoder.encode(ad);
            }
          }
          catch (e) { console.warn("[ADM:sceneRecord] audio encode:", e); _stopAudio(); }
          finally { try { ad.close(); } catch { /* noop */ } }
        }
      })();
    } catch (e) { console.warn("[ADM:sceneRecord] audio init:", e); _stopAudio(); }
  }
  // realtime, NOT quality: in non-realtime mode Windows/MF encoders (Intel first
  // and foremost) enable B-frames, while mp4-muxer's ctts is UNSIGNED (version 0) —
  // real B-frame offsets don't fit, the muxer kills the recording with «Timestamps must be
  // monotonically increasing». realtime disables B-frames by construction; at our
  // bitrates there is no visible difference.
  encoder.configure({ codec, width: outW, height: outH, bitrate, framerate: fps, latencyMode: "realtime" });

  const usTs = (n) => Math.round(n * 1e6 / fps); // exact CFR timings: round(n·Δ), not n·round(Δ) — no drift
  let raf = 0, stopped = false, submitted = 0, startAt = 0, qBlocked = 0;
  const _submit = () => {
    const ts = usTs(submitted);
    const vf = new VideoFrame(cropCanvas, { timestamp: ts, duration: usTs(submitted + 1) - ts });
    // close in finally: encode on a closed encoder throws — without close the frames
    // would pile up uncollected (GPU memory) until the end of the recording.
    try { encoder.encode(vf, { keyFrame: submitted % (fps * 2) === 0 }); }
    finally { vf.close(); }
    submitted++;
  };
  const pump = () => {
    if (stopped) return;
    if (encError) return; // encoder is dead: don't burn rAF or produce frames for nothing
    try {
      if (!startAt) startAt = performance.now();
      src.drawFrame(); // a fresh frame EVERY tick — content freshness takes priority
      // Strict wall-clock CFR: ALL missing slots (gaps from an encoder queue
      // jam / rAF stall) are filled with the CURRENT frame. That way events in the
      // video stay in place relative to the audio (which runs on the wall-clock).
      // The previous «freeze on the last frame before the gap» accumulated picture
      // lag — the audio ran ahead by exactly the length of the jams.
      const want = Math.floor((performance.now() - startAt) / 1000 * fps) + 1;
      let burst = 0; // duplicates are cheap, but we respect the encoder queue
      while (submitted < want && burst < 60 && encoder.encodeQueueSize < 60) {
        _submit(); burst++;
      }
      if (submitted < want) qBlocked++; // diagnostics: the encoder can't keep up
    } catch (e) { encError = encError ?? e; }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  // Cleanup is IDEMPOTENT and unconditional: close() on a closed encoder is already in try,
  // stop() on stopped tracks is a noop. A «finished» guard would be harmful here:
  // a hung flush + the 15 s race timeout → abort from finally must clean up the
  // tracks/hidden <video>/encoder, otherwise it leaks until re-login.
  const abort = () => {
    stopped = true;
    try { cancelAnimationFrame(raf); } catch { /* noop */ }
    try { encoder.close(); } catch { /* noop */ }
    _stopAudio();
    src.stopSource();
  };
  const finish = async () => {
    stopped = true;
    try { cancelAnimationFrame(raf); } catch { /* noop */ }
    try { await encoder.flush(); } catch (e) { encError = encError ?? e; }
    if (aEncoder && !aDead) { try { await aEncoder.flush(); } catch (e) { console.warn("[ADM:sceneRecord] audio flush:", e); } }
    abort();
    if (encError) throw encError;
    muxer.finalize();
    return { blob: new Blob([target.buffer], { type: "video/mp4" }), frames: submitted, qBlocked };
  };
  return { abort, finish, hasError: () => encError != null, outW, outH };
}

/** Suppress hover artifacts for the duration of the recording. Token borders and hover names
 *  are drawn IN THE SAME canvas that captureStream records — they can't be cut out of the
 *  stream, so we hide them while recording: turn off the border on all tokens
 *  (the border only appears on hover/selection) and the nameplate — ONLY on tokens
 *  with a hover name display mode (permanently visible names are part of the scene's look).
 *  The refreshToken hook re-hides after every redraw (hover during
 *  recording). Returns a stop function: removes the hook and restores the normal
 *  visibility with a full refresh. */
function _startHoverSuppression() {
  const HOVER_MODES = new Set([
    CONST.TOKEN_DISPLAY_MODES.HOVER,
    CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
  ]);
  const _hide = (t) => {
    try {
      if (t?.border) t.border.visible = false;
      const _dm = Number(t?.document?.displayName ?? 0);
      if (t?.nameplate && HOVER_MODES.has(_dm)) t.nameplate.visible = false;
    } catch { /* noop */ }
  };
  for (const t of (canvas.tokens?.placeables ?? [])) _hide(t);
  const _hookId = Hooks.on("refreshToken", _hide);
  // Recording marker for the game system: canvas overlays (the distance label in the AOE center)
  // are not drawn while this class is present — otherwise they end up in the captureStream.
  try { document.body.classList.add("adm-scene-record"); } catch { /* noop */ }
  return () => {
    try { document.body.classList.remove("adm-scene-record"); } catch { /* noop */ }
    try { Hooks.off("refreshToken", _hookId); } catch { /* noop */ }
    try {
      for (const t of (canvas.tokens?.placeables ?? [])) {
        t.renderFlags?.set?.({ refreshState: true });
      }
    } catch { /* noop */ }
  };
}

async function _recordScene() {
  if (_busy) { ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.sceneRecord.alreadyRunning")); return; }
  if (!game.user?.isGM) { ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.sceneRecord.gmOnly")); return; }
  if (!canvas?.ready || !canvas.scene) { ui.notifications?.warn(game.i18n.localize("ADM_LEVELS.sceneRecord.sceneNotReady")); return; }

  const view = canvas.app?.view;
  if (typeof view?.captureStream !== "function") { ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.captureUnsupported")); return; }

  let duration = Number(game.settings.get(MODULE_ID, SETTING_DURATION));
  duration = Math.max(1, Math.min(600, Number.isFinite(duration) ? duration : 15));

  _busy = true;
  let prev = null; // current view — restored in finally (captured INSIDE try: reading the stage must not leave _busy=true on throw)
  let stopHoverSuppress = null; // lifting the border/hover-name suppression — also from finally
  let stopCapture = null; // hoisted into finally's scope — rAF/stream/video cleanup is reachable from ANY error path (e.g. a throw from rec.start())
  let audioTap = null; // Environment+Interface audio tap — stopped from finally too
  let restoreDsnHide = null; // restore the DSN dice timeBeforeHide — from finally

  try {
    // Dice So Nice dice: their WebGL canvas is readable only with their own user flag
    // preserveDrawingBuffer (DSN keeps it precisely for capture). We set it ourselves
    // once; the DSN renderer is created AT SESSION START (ready) and cached — the flag
    // takes effect only after a reload, unconditionally.
    try {
      if (game.modules?.get?.("dice-so-nice")?.active && !game.user?.getFlag?.("dice-so-nice", "preserveDrawingBuffer")) {
        await game.user.setFlag("dice-so-nice", "preserveDrawingBuffer", true);
        ui.notifications?.info(game.i18n.localize("ADM_LEVELS.sceneRecord.dsnCaptureEnabled"));
      }
    } catch { /* noop */ }

    // During the recording DSN dice hide faster: timeBeforeHide → 500 ms.
    // ⚠️ DSN reads its config from the USER FLAG "settings" (Dice3D.CONFIG), while
    // the client setting of the same name is legacy, emptied by a migration (the first
    // version of this fix wrote there — zero effect). The flag is read live when
    // the hide is scheduled — no restart needed. The previous value is restored in finally.
    try {
      if (game.modules?.get?.("dice-so-nice")?.active) {
        const _dsnCfg = foundry.utils.deepClone(game.user.getFlag("dice-so-nice", "settings") ?? {});
        const _prevTbh = _dsnCfg.timeBeforeHide;
        if ((Number(_prevTbh) || 2000) > 500) {
          _dsnCfg.timeBeforeHide = 500;
          await game.user.setFlag("dice-so-nice", "settings", _dsnCfg);
          restoreDsnHide = async () => {
            const c = foundry.utils.deepClone(game.user.getFlag("dice-so-nice", "settings") ?? {});
            // setFlag merges objects — deleting the key won't work; DSN default = 2000.
            c.timeBeforeHide = (_prevTbh === undefined) ? 2000 : _prevTbh;
            await game.user.setFlag("dice-so-nice", "settings", c);
          };
        }
      }
    } catch { /* noop */ }

    prev = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    // Hide token borders and hover names BEFORE capture — they won't end up in the recording.
    stopHoverSuppress = _startHoverSuppression();
    await _fitSceneToView();
    await new Promise((r) => setTimeout(r, 250)); // let the frames settle after the pan

    // Audio of the «Environment» and «Interface» channels (setting; music is intentionally not recorded).
    try { if (game.settings.get(MODULE_ID, SETTING_AUDIO) !== false) audioTap = _openGameAudioTap(); }
    catch { audioTap = null; }

    const fps = 60;

    // Path 1: an edit-ready MP4 right away (WebCodecs). If it fails (no WebCodecs/codec/
    // frames) → path 2: MediaRecorder webm, as before.
    let mp4 = null;
    try {
      mp4 = await _startMp4Capture(view, fps, duration, audioTap);
    } catch (e) {
      console.warn("[ADM:sceneRecord] mp4 capture unavailable, fallback to webm:", e);
    }
    if (mp4) {
      stopCapture = mp4.abort;
      ui.notifications?.info(game.i18n.format("ADM_LEVELS.sceneRecord.recording", { duration }));
      // Wait in ticks: a fatal encoder failure mid-recording surfaces immediately,
      // not after the full duration (up to 600 s wasted).
      const _t0 = performance.now();
      while (performance.now() - _t0 < duration * 1000) {
        if (mp4.hasError()) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const _elapsed = (performance.now() - _t0) / 1000;
      // Safety net: if finalization hangs (encoder/GPU failure) — don't get stuck on
      // _busy; abort from finally cleans up the tracks/encoder. catch on the losing
      // promise of the race — otherwise its late reject produces an unhandled rejection.
      const _finishP = mp4.finish();
      _finishP.catch(() => { /* noop */ });
      const { blob, frames, qBlocked } = await Promise.race([
        _finishP,
        new Promise((_, rej) => setTimeout(() => rej(new Error("scene-record: mp4 finalize timeout")), 15000)),
      ]);
      if (!blob.size) { ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.emptyRecording")); return; }
      // Console diagnostics: how many frames were recorded over how many seconds and how
      // often the encoder couldn't keep up (qBlocked ticks with a saturated queue).
      console.info(`[ADM:sceneRecord] mp4: ${frames} frames in ${_elapsed.toFixed(1)}s; ticks with encoder backlog: ${qBlocked}`);
      // The encoder consistently couldn't keep up (software fallback/weak GPU): the clip
      // is shorter and «faster» than real time — warn the user plainly.
      if (frames / fps < _elapsed * 0.95) {
        ui.notifications?.warn(game.i18n.format("ADM_LEVELS.sceneRecord.encoderLagged", { got: Math.round(frames / fps), total: Math.round(_elapsed) }));
      }
      await _saveRecording(blob, "mp4", canvas.scene.name);
      return;
    }

    const mime = _pickVideoMime();
    if (!mime) { ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.mediaRecorderUnsupported")); return; }

    // Crop EXACTLY to the scene bounds — no black bars when the window aspect ≠ the scene aspect.
    // When the aspects match, fracW=fracH=1 → full frame (equivalent to the previous behavior).
    let cap = null;
    try {
      cap = await _startCroppedCapture(view, fps);
    } catch (e) {
      console.warn("[ADM:sceneRecord] cropped capture failed, fallback to full viewport:", e);
    }
    const stream = cap?.stream ?? view.captureStream(fps);
    // Audio in the webm fallback: just add the tap track — MediaRecorder itself
    // encodes it as Opus alongside the video.
    if (audioTap?.track) { try { stream.addTrack(audioTap.track); } catch { /* noop */ } }
    const outW = cap?.outW ?? (view.width || canvas.screenDimensions[0]);
    const outH = cap?.outH ?? (view.height || canvas.screenDimensions[1]);
    stopCapture = cap?.stop ?? (() => { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ } });
    // «Maximum quality» with a reasonable cap: ~0.2 bits/pixel*fps.
    const bitrate = Math.min(120_000_000, Math.max(8_000_000, Math.round(outW * outH * fps * 0.2)));

    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    } catch (e) {
      console.warn("[ADM:sceneRecord] MediaRecorder init failed:", e);
      ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.startFailed"));
      stopCapture();
      throw e;
    }
    rec.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
    const done = new Promise((resolve) => {
      rec.onstop = () => resolve();
      rec.onerror = (ev) => { console.error("[ADM:sceneRecord] recorder error:", ev); resolve(); };
      // Safety net: if onstop/onerror never arrive (encoder/GPU failure) — don't get stuck on
      // _busy forever. 8 s of slack on top of the recording duration.
      setTimeout(resolve, duration * 1000 + 8000);
    });

    ui.notifications?.info(game.i18n.format("ADM_LEVELS.sceneRecord.recording", { duration }));
    rec.start();
    await new Promise((r) => setTimeout(r, duration * 1000));
    try { rec.stop(); } catch { /* noop */ }
    await done;
    stopCapture();

    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) { ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.emptyRecording")); return; }
    await _saveRecording(blob, ext, canvas.scene.name);
  } catch (e) {
    console.error("[ADM:sceneRecord] record failed:", e);
    ui.notifications?.error(game.i18n.localize("ADM_LEVELS.sceneRecord.failed"));
  } finally {
    // Idempotent safety net: if the recording was cut short by an exception (e.g. rec.start() threw) —
    // stopCapture was already called on the happy path, a repeat is harmless (stopped=true, stopping stopped tracks = noop).
    try { stopCapture?.(); } catch { /* noop */ }
    try { audioTap?.stop(); } catch { /* noop */ }
    try { restoreDsnHide?.(); } catch { /* noop */ }
    try { stopHoverSuppress?.(); } catch { /* noop */ }
    try { if (prev) canvas.animatePan({ x: prev.x, y: prev.y, scale: prev.scale, duration: 300 }); } catch { /* noop */ }
    _busy = false;
  }
}

export const TOOL = {
  id: "sceneRecord",
  name: "ADM_LEVELS.settings.sceneRecord.name",
  hint: "ADM_LEVELS.settings.sceneRecord.hint",

  onInit() {
    game.settings.register(MODULE_ID, SETTING_DURATION, {
      name: "ADM_LEVELS.sceneRecord.durationName",
      hint: "ADM_LEVELS.sceneRecord.durationHint",
      scope: "world",
      config: true,
      type: Number,
      default: 15,
      range: { min: 1, max: 600, step: 1 },
    });
    game.settings.register(MODULE_ID, SETTING_AUDIO, {
      name: "ADM_LEVELS.sceneRecord.audioName",
      // hint is intentionally NOT set: no tooltip is needed under the checkbox or in the popup.
      // The text remains in lang as ADM_LEVELS.sceneRecord.audioHint — to bring it back, add a hint line.
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });
  },

  onReady({ isEnabled }) {
    // «Record scene» item in the navbar scene's right-click menu (active scene only, GM).
    Hooks.on("getSceneContextOptions", (app, items) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM) return;
      items.push({
        name: "ADM_LEVELS.sceneRecord.menu", // ContextMenu localizes item.name itself
        icon: '<i class="fa-solid fa-video"></i>',
        condition: (li) => {
          const el = li?.dataset ? li : li?.[0];
          const sceneId = el?.dataset?.sceneId;
          return !!sceneId && sceneId === (canvas?.scene?.id ?? null);
        },
        callback: () => { _recordScene(); },
      });
    });
  },
};
