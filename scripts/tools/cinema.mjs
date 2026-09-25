// modules/adm-levels/scripts/tools/cinema.mjs
// ADMaps Tools — «ADMaps Cinema».
// Cinematic camera in regular play (not while recording): clicking a token — a soft
// zoom-in to the configured level; targets of the controlled token — auto-zoom that
// fits it and all targets with configurable paddings (px) from the screen edges (for
// overlapping UI); movement of the controlled token — smooth camera follow.
// Hard rule: the camera never shows blackness beyond the scene rect — as long as
// that is possible at all at the current scale (screen wider than scene → center the axis).
// ALL settings are client-side: every player enables and tunes them for their own comfort.
// Also works during «Scene recording»: the clamp (full viewport inside the rect) is
// stricter than the recording crop (central part of the viewport) — no blackness gets
// into the video. The recording no longer has its own cinema mode.

const MODULE_ID = "adm-levels";

const CINEMA_PAN_MS = 800;         // duration of zoom-in/reframing
const CINEMA_FOLLOW_LERP = 0.08;   // follow smoothing (fraction of the path per frame at 60 fps)
const CINEMA_MOVE_GRACE_MS = 1200; // after the target stops, follow "releases" the camera (manual pan is respected)

const S = {
  clickZoom: "cinema.clickZoom",
  clickScale: "cinema.clickZoomScale",
  follow: "cinema.follow",
  targetZoom: "cinema.targetZoom",
  padTop: "cinema.padTop",
  padRight: "cinema.padRight",
  padBottom: "cinema.padBottom",
  padLeft: "cinema.padLeft",
};

const _get = (key, fallback) => {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
};
const _num = (key, fallback) => {
  const v = Number(_get(key, fallback));
  return Number.isFinite(v) ? v : fallback;
};

function _sceneRect() {
  const dims = canvas.dimensions;
  return dims.sceneRect ?? { x: dims.sceneX, y: dims.sceneY, width: dims.sceneWidth, height: dims.sceneHeight };
}

/** Minimum scale at which the whole screen is inside the scene (no blackness).
 *  May exceed maxZoom on tiny scenes — then blackness is unavoidable. */
function _coverScale() {
  const rect = _sceneRect();
  const [sw, sh] = canvas.screenDimensions;
  return Math.max(sw / rect.width, sh / rect.height);
}

/** Clamp the camera center: the full viewport (sw×sh at scale s) must not
 *  stick out past the scene rect; if the screen is wider than the scene on an axis — center that axis. */
function _clampCenter(x, y, s) {
  const rect = _sceneRect();
  const [sw, sh] = canvas.screenDimensions;
  const halfW = sw / (2 * s);
  const halfH = sh / (2 * s);
  const cx = (halfW * 2 >= rect.width) ? rect.x + rect.width / 2
    : Math.min(Math.max(x, rect.x + halfW), rect.x + rect.width - halfW);
  const cy = (halfH * 2 >= rect.height) ? rect.y + rect.height / 2
    : Math.min(Math.max(y, rect.y + halfH), rect.y + rect.height - halfH);
  return { x: cx, y: cy };
}

/** v13 zoom limits live in canvas.dimensions.scale.{min,max} (recomputed per scene);
 *  CONFIG.Canvas.minZoom/maxZoom are undefined by default. Clamp with the SAME
 *  bounds that canvas.pan/animatePan will apply — otherwise the requested scale
 *  would silently land on a different one, and our positional clamp would be computed
 *  for a foreign scale (blackness at the edge + follow jitter). */
const _zoomClamp = (s) => {
  const d = canvas.dimensions?.scale;
  const lo = Number(d?.min) || CONFIG.Canvas.minZoom || 0.05;
  const hi = Number(d?.max) || CONFIG.Canvas.maxZoom || 3;
  return Math.max(lo, Math.min(hi, s));
};

/** The user's current targets on the current canvas. */
function _userTargets() {
  return [...(game.user?.targets ?? [])].filter((t) => t && !t.destroyed && t.parent);
}

/** Token center by the COMMITTED position (document), not the rendered one:
 *  during a drag/animation the document stays put or is already at the destination — the camera
 *  frames the final spot, and the token "nicely arrives into the frame" instead of dragging the camera. */
const _docCenter = (t) => ({
  x: (t.document?.x ?? t.x) + t.w / 2,
  y: (t.document?.y ?? t.y) + t.h / 2,
});

/** (World) bounding box around a set of tokens — also by document positions. */
function _tokensBBox(tokens) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tokens) {
    const dx = t.document?.x ?? t.x, dy = t.document?.y ?? t.y;
    minX = Math.min(minX, dx); minY = Math.min(minY, dy);
    maxX = Math.max(maxX, dx + t.w); maxY = Math.max(maxY, dy + t.h);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

const _pads = () => ({
  t: Math.max(0, _num(S.padTop, 100)),
  r: Math.max(0, _num(S.padRight, 100)),
  b: Math.max(0, _num(S.padBottom, 100)),
  l: Math.max(0, _num(S.padLeft, 100)),
});

/** Effective paddings: a pair on one axis cannot eat the whole screen (at least 80px of frame),
 *  excess is shrunk proportionally. Use BOTH in the fit AND in the center
 *  offset — a raw giant padding would push the frame entirely off screen. */
function _effPads(sw, sh) {
  const p = _pads();
  const kx = (p.l + p.r) > (sw - 80) ? Math.max(0, (sw - 80) / (p.l + p.r)) : 1;
  const ky = (p.t + p.b) > (sh - 80) ? Math.max(0, (sh - 80) / (p.t + p.b)) : 1;
  return { t: p.t * ky, r: p.r * kx, b: p.b * ky, l: p.l * kx };
}

/** "Target zoom" view: fit sel+targets into the screen minus paddings.
 *  Paddings are asymmetric → the frame center is shifted (bottom 400 = content moves up).
 *  Priorities: no blackness > fit everyone > not closer than the zoom level. */
function _targetsView(sel, targets) {
  const bb = _tokensBBox([sel, ...targets]);
  const [sw, sh] = canvas.screenDimensions;
  const p = _effPads(sw, sh);
  const availW = Math.max(80, sw - p.l - p.r); // floor — a safety net, _effPads already guarantees it
  const availH = Math.max(80, sh - p.t - p.b);
  const sFit = Math.min(availW / Math.max(1, bb.w), availH / Math.max(1, bb.h));
  let s = Math.min(sFit, _num(S.clickScale, 1)); // do not zoom in closer than the comfortable level
  s = _zoomClamp(Math.max(s, _coverScale()));    // blackness matters more than fitting
  const cx = bb.cx + (p.r - p.l) / (2 * s);
  const cy = bb.cy + (p.b - p.t) / (2 * s);
  return { ..._clampCenter(cx, cy, s), scale: s };
}

/** "Zoom to token" view: level from settings, but not smaller than cover (no blackness). */
function _tokenView(sel) {
  const s = _zoomClamp(Math.max(_num(S.clickScale, 1), _coverScale()));
  const c = _docCenter(sel);
  return { ..._clampCenter(c.x, c.y, s), scale: s };
}

export const TOOL = {
  id: "cinema",
  name: "ADM_LEVELS.settings.cinema.name",
  hint: "ADM_LEVELS.settings.cinema.hint",
  settingScope: "client", // every player enables it themselves
  defaultEnabled: false,  // OFF by default

  onInit() {
    const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, ...data });
    reg(S.clickZoom, {
      name: "ADM_LEVELS.cinema.clickZoomName", hint: "ADM_LEVELS.cinema.clickZoomHint",
      type: Boolean, default: true,
    });
    reg(S.clickScale, {
      name: "ADM_LEVELS.cinema.clickScaleName", hint: "ADM_LEVELS.cinema.clickScaleHint",
      type: Number, default: 1, range: { min: 0.2, max: 3, step: 0.05 },
    });
    reg(S.targetZoom, {
      name: "ADM_LEVELS.cinema.targetZoomName", hint: "ADM_LEVELS.cinema.targetZoomHint",
      type: Boolean, default: true,
    });
    reg(S.padTop, { name: "ADM_LEVELS.cinema.padTopName", hint: "ADM_LEVELS.cinema.padHint", type: Number, default: 100 });
    reg(S.padRight, { name: "ADM_LEVELS.cinema.padRightName", hint: "ADM_LEVELS.cinema.padHint", type: Number, default: 100 });
    reg(S.padBottom, { name: "ADM_LEVELS.cinema.padBottomName", hint: "ADM_LEVELS.cinema.padHint", type: Number, default: 100 });
    reg(S.padLeft, { name: "ADM_LEVELS.cinema.padLeftName", hint: "ADM_LEVELS.cinema.padHint", type: Number, default: 100 });
    reg(S.follow, {
      name: "ADM_LEVELS.cinema.followName", hint: "ADM_LEVELS.cinema.followHint",
      type: Boolean, default: true,
    });
  },

  onReady({ isEnabled }) {
    let timer = 0;
    let gen = 0;             // transition generation: a stale _apply does not start following
    let followToken = null;  // follow target
    let tickerFn = null;
    let lastDesired = null;  // last desired point — "target is moving" detector
    let lastSetKey = null;   // frame composition (token+targets): composition change ≠ movement
    let lastScale = null;    // scale of the previous tick: zoom change (wheel) ≠ movement
    let lastMoveAt = 0;      // when the desired point last changed
    let manualHold = false;  // user touched the camera while following → stay silent until a NEW movement start
    let targetsHold = false; // user touched the camera while framing targets → target zoom stays silent until the next target event
    let expectedCam = null;  // what we ourselves wrote into the camera on the previous tick (foreign-hand detection)
    let wasChasing = false;

    // The sub-module stays silent: disabled or canvas not ready.
    const _gate = () => isEnabled() && !!canvas?.ready;

    const _sel = () => {
      const c = canvas.tokens?.controlled ?? [];
      return c.length ? c[c.length - 1] : null;
    };

    const _stopFollow = () => {
      followToken = null;
      lastDesired = null;
      lastSetKey = null;
      lastScale = null;
      lastMoveAt = 0;
      expectedCam = null;
      wasChasing = false;
      // manualHold/targetsHold are NOT touched: the user's priority survives transitions,
      // only explicit new intents clear it (click/target/new movement).
      if (tickerFn) { try { canvas.app?.ticker?.remove(tickerFn); } catch { /* noop */ } tickerFn = null; }
    };

    // Desired follow point AT THE CURRENT scale: center of the sel+targets bbox (with
    // the padding offset) or the token center.
    const _followPoint = (tk, s) => {
      const targets = _get(S.targetZoom, true) ? _userTargets() : [];
      if (targets.length) {
        const bb = _tokensBBox([tk, ...targets]);
        const p = _effPads(...canvas.screenDimensions);
        return {
          ..._clampCenter(bb.cx + (p.r - p.l) / (2 * s), bb.cy + (p.b - p.t) / (2 * s), s),
          targetsActive: true,
          setKey: [tk.id, ...targets.map((t) => t.id).sort()].join("|"),
        };
      }
      const c = _docCenter(tk);
      return { ..._clampCenter(c.x, c.y, s), targetsActive: false, setKey: tk.id };
    };

    const _startFollow = (t) => {
      followToken = t;
      if (tickerFn) return;
      tickerFn = () => {
        const tk = followToken;
        if (!tk) return;
        try {
          if (!_gate() || !_get(S.follow, true) || tk.destroyed || !tk.parent) { _stopFollow(); return; }
          const now = performance.now();
          const s = canvas.stage.scale.x;
          const p = _followPoint(tk, s);
          // Target movement detector: the desired point changes = token/targets are moving.
          // A change of frame COMPOSITION (target removed/added) is NOT movement: we only
          // rebase, without jerking the camera (the reframing trigger is an explicit
          // "target acquired", not a removal). A change of SCALE (user's wheel) is also
          // not movement: the desired point depends on s (paddings, clamp at the edge) and
          // would shift without a single token step.
          if (!lastDesired || p.setKey !== lastSetKey || s !== lastScale) {
            lastSetKey = p.setKey;
            lastScale = s;
            lastDesired = p; // first tick/new composition/new zoom — only the base point, NO chase
          } else if (Math.abs(p.x - lastDesired.x) > 0.5 || Math.abs(p.y - lastDesired.y) > 0.5) {
            const wasIdle = now > lastMoveAt + CINEMA_MOVE_GRACE_MS;
            lastMoveAt = now;
            lastDesired = p;
            // A NEW movement start after a pause — the manual priority expires.
            if (manualHold && wasIdle) manualHold = false;
          }
          // A foreign hand on the camera during our chase → yield immediately.
          const cur = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, s };
          if (wasChasing && expectedCam) {
            const foreign = Math.abs(cur.x - expectedCam.x) > 1 || Math.abs(cur.y - expectedCam.y) > 1
              || Math.abs(cur.s - expectedCam.s) > 0.0005;
            if (foreign) {
              manualHold = true;                       // following — until a new movement start
              if (p.targetsActive) targetsHold = true; // target zoom — until the next target
              expectedCam = null;
              wasChasing = false;
              return;
            }
          }
          const wantChase = now <= lastMoveAt + CINEMA_MOVE_GRACE_MS
            && !manualHold && !(p.targetsActive && targetsHold);
          if (!wantChase) { expectedCam = null; wasChasing = false; return; }
          const dx = p.x - cur.x;
          const dy = p.y - cur.y;
          if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
            const k = 1 - Math.pow(1 - CINEMA_FOLLOW_LERP, canvas.app.ticker.deltaTime || 1);
            canvas.pan({ x: cur.x + dx * k, y: cur.y + dy * k, scale: s });
          }
          // Baseline for foreign-hand detection — the ACTUAL position after the pan
          // (canvas.pan may have trimmed our value with its own constraint).
          expectedCam = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, s: canvas.stage.scale.x };
          wasChasing = true;
        } catch { /* noop */ }
      };
      try { canvas.app.ticker.add(tickerFn); } catch { tickerFn = null; followToken = null; }
    };

    const _apply = async (retried, kind) => {
      timer = 0;
      // LMB held = the user may be dragging a token: a transition now would break the drag.
      // Defer until release — there we will also see the already committed drop point.
      if (pointerHeld) { deferredKind = (deferredKind === "control") ? "control" : kind; return; }
      const myGen = ++gen;
      try {
        if (!_gate()) { _stopFollow(); return; }
        const sel = _sel();
        _stopFollow(); // the ticker must not fight with the animatePan transition
        if (!sel) return; // deselecting does not touch the camera — we do not force a wide shot
        const targets = _get(S.targetZoom, true) ? _userTargets() : [];
        let view = null;
        if (targets.length) view = _targetsView(sel, targets);
        // Fallback to click-zoom — ONLY from a click on a token: a target trigger with
        // emptied targets (target removed during the debounce) does not touch the camera.
        else if (kind !== "target" && _get(S.clickZoom, true)) view = _tokenView(sel);
        if (view) {
          const ok = await canvas.animatePan({ x: view.x, y: view.y, scale: view.scale, duration: CINEMA_PAN_MS });
          if (myGen !== gen) return; // a newer transition arrived during the zoom-in
          // false = the transition was INTERRUPTED by a foreign pan (core auto-pan on token
          // movement, combat tracker): the camera got stuck halfway — finish with a single
          // retry once the foreign animation has completed.
          if (ok === false && !retried) {
            setTimeout(() => { if (myGen === gen) _apply(true, kind); }, 350);
            return;
          }
        }
        if (_get(S.follow, true) && _sel() === sel) _startFollow(sel);
      } catch { /* noop */ }
    };

    let pointerHeld = false;    // LMB held (a token drag is possible)
    let deferredKind = null;    // transition deferred until LMB release
    let downPos = null;         // screen point of pointerdown — to tell a click from a drag
    let awaitCommitKind = null; // after a drag release we wait for the position COMMIT (updateToken)
    let commitTimer = 0;        // fallback if the move was cancelled/never happened
    window.addEventListener("pointerdown", (e) => {
      if (e.button === 0) { pointerHeld = true; downPos = { x: e.clientX, y: e.clientY }; }
    }, true);
    const _pointerRelease = (e) => {
      if (e && e.type !== "blur" && e.button !== 0) return;
      pointerHeld = false;
      if (!deferredKind) return;
      const k = deferredKind;
      deferredKind = null;
      if (!_gate()) return;
      // Drag (the cursor really moved): on release the token document is still OLD —
      // the update is in flight to the server. Zooming now = "to the point where the token
      // was, then catch up" (sloppy). Wait for the position commit — the transition fires
      // once, straight to the destination (updateToken hook below).
      const dragged = e?.type === "pointerup" && downPos
        && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6;
      if (dragged) {
        awaitCommitKind = k;
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          // No commit arrived (selection rectangle, cancelled/empty drop) — frame as is.
          commitTimer = 0;
          if (awaitCommitKind) { const kk = awaitCommitKind; awaitCommitKind = null; if (_gate()) _schedule(kk); }
        }, 800);
      } else {
        _schedule(k);
      }
    };
    window.addEventListener("pointerup", _pointerRelease, true);
    window.addEventListener("pointercancel", _pointerRelease, true);
    window.addEventListener("blur", _pointerRelease); // do not lose a release outside the window

    let pendingKind = null; // source of the burst merged by the debounce; click outranks target
    const _schedule = (kind) => {
      // Debounce: switching between tokens (release+control) and target storms
      // (mass targeting) are merged into a single transition.
      pendingKind = (pendingKind === "control") ? "control" : kind;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { const k = pendingKind; pendingKind = null; _apply(false, k); }, 60);
    };

    Hooks.on("controlToken", () => {
      if (!_gate()) return;
      manualHold = false; targetsHold = false; // click = a new explicit intent
      _schedule("control");
    });
    Hooks.on("targetToken", (user, _token, targeted) => {
      if (user !== game.user) return;         // camera — only for OUR OWN targets
      if (!targeted) return;                  // trigger — only "target acquired": removal does not touch the camera
      if (!_gate() || !_sel()) return;        // no target zoom without a controlled token
      if (!_get(S.targetZoom, true)) return;
      targetsHold = false;                    // a new targeting act lifts the target-zoom hold
      _schedule("target");
    });
    // Move commit after a drag: the deferred transition fires at the DESTINATION
    // POINT (document is already new), not at the old position.
    Hooks.on("updateToken", (doc, changes) => {
      if (!awaitCommitKind) return;
      if (!("x" in changes) && !("y" in changes)) return;
      const sel = _sel();
      if (!sel || doc.id !== sel.id || doc.parent !== canvas.scene) return;
      const k = awaitCommitKind;
      awaitCommitKind = null;
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = 0; }
      if (_gate()) _schedule(k);
    });
    // Scene change: old references are dead — kill following, cut off the tail of transitions.
    Hooks.on("canvasTearDown", () => {
      gen++;
      if (timer) { clearTimeout(timer); timer = 0; }
      deferredKind = null;
      awaitCommitKind = null;
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = 0; }
      _stopFollow();
      manualHold = false; targetsHold = false;
    });

    // The sub-module's option settings go into a collapsible: 8 rows eat too much space
    // in the module settings panel. The sub-module's own checkbox (tool.cinema) stays outside.
    Hooks.on("renderSettingsConfig", (_app, element) => {
      try {
        const root = element instanceof HTMLElement ? element : (element?.[0] ?? element);
        if (!root?.querySelectorAll) return;
        const inputs = root.querySelectorAll(`[name^="${MODULE_ID}.cinema."]`);
        if (!inputs.length) return;
        const groups = [...new Set([...inputs].map((i) => i.closest(".form-group")).filter(Boolean))];
        if (!groups.length || groups[0].closest("details.adm-cinema-options")) return;
        const details = document.createElement("details");
        details.className = "adm-cinema-options";
        details.style.cssText = "margin:4px 0 8px;border:1px solid var(--color-border-light-tertiary, #7a7971);border-radius:4px;padding:2px 8px 6px;";
        const summary = document.createElement("summary");
        summary.textContent = game.i18n.localize("ADM_LEVELS.cinema.optionsGroup");
        summary.style.cssText = "cursor:pointer;font-weight:bold;padding:4px 0;";
        details.appendChild(summary);
        groups[0].parentNode.insertBefore(details, groups[0]);
        for (const g of groups) details.appendChild(g); // moving nodes preserves listeners
      } catch { /* noop */ }
    });
  },
};
