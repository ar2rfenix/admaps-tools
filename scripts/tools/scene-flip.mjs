// ADMaps Scene Flip
// Flip a whole scene horizontally / vertically / 180°.
//
// The scene BACKGROUND (and FOREGROUND) image/video cannot be transformed via data:
// Foundry's PrimaryCanvasGroup#drawSceneMesh ignores background.scaleX/scaleY/rotation
// and only fills the scene rect with the texture. So we convert the background (and
// foreground) into a full-scene Tile, which DOES honor texture.scaleX/scaleY/rotation,
// then mirror it together with every other placeable by reflecting coordinates.
//
// Control: right-click a scene in the navigation → "Scene Flip" → hover → submenu with
// Flip Vertically / Flip Horizontally / Rotate 180°.

const MOD = "admaps-scene-flip";

// ⚠️ getFlag/setFlag/unsetFlag with the namespace of a REMOVED module throw "scope not valid or not active".
// We access the flags DIRECTLY (data under the old namespace is intact; same behavior, minus the scope validation).
const _flagGet = (doc, ns, key) => foundry.utils.getProperty(doc?.flags ?? {}, `${ns}.${key}`);
const _flagSet = (doc, ns, key, val) => doc.update({ [`flags.${ns}.${key}`]: val });
const _flagDel = (doc, ns, key) => doc.update({ [`flags.${ns}.-=${key}`]: null });

const I18N = "ADMAPS_SCENE_FLIP";

function _t(key, data) {
  const full = `${I18N}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

const MODE_LABEL = { vertical: "FlipV", horizontal: "FlipH", rotate180: "Rotate180" };

/* ───────────────────────── Geometry ───────────────────────── */

/**
 * Build a reflector for the given scene rectangle and flip mode.
 * Coordinate reflection across the scene rect [sceneX, sceneY, sceneWidth, sceneHeight].
 * Angle conventions:
 *   angUp  — for rotation fields measured clockwise with 0° = "up"
 *            (tokens, tiles, lights, drawings, rectangle/ellipse region shapes).
 *   angDir — for MeasuredTemplate.direction, measured from +X axis.
 */
function makeReflector(scene, mode) {
  const d = scene.dimensions;
  const X0 = d.sceneX, Y0 = d.sceneY, W = d.sceneWidth, H = d.sceneHeight;
  const flipX = (mode === "horizontal" || mode === "rotate180");
  const flipY = (mode === "vertical" || mode === "rotate180");

  const px = (x) => (flipX ? (2 * X0 + W - x) : x);
  const py = (y) => (flipY ? (2 * Y0 + H - y) : y);

  const norm = (a) => ((Number(a) % 360) + 360) % 360;
  const angUp = (a) => {
    let r = norm(a);
    if (flipX) r = (360 - r) % 360;   // reflect across vertical axis
    if (flipY) r = (180 - r + 360) % 360; // reflect across horizontal axis
    return r;
  };
  const angDir = (a) => {
    let r = norm(a);
    if (flipX) r = (180 - r + 360) % 360;
    if (flipY) r = (360 - r) % 360;
    return r;
  };
  // For objects whose CONTENT is also mirrored (tiles via texture.scaleX/scaleY,
  // drawings via local point mirroring). The content flip already encodes the axis,
  // so rotation must NOT double-count it: a single reflection inverts rotation
  // (θ→360−θ), two reflections (rotate180) leave rotation unchanged while both
  // scales flip. Using angUp here double-applied the flip (vertical looked horizontal,
  // rotate180 cancelled out).
  const angFlip = (a) => {
    const r = norm(a);
    return (flipX !== flipY) ? ((360 - r) % 360) : r;
  };

  return { px, py, flipX, flipY, angUp, angDir, angFlip };
}

/** Reflect a single region shape (rectangle / circle / ellipse / polygon). */
function reflectRegionShape(shape, R) {
  const o = foundry.utils.deepClone(shape);
  switch (o.type) {
    case "rectangle": {
      const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
      o.x = R.px(cx) - o.width / 2;
      o.y = R.py(cy) - o.height / 2;
      o.rotation = R.angUp(o.rotation ?? 0);
      break;
    }
    case "ellipse":
      o.x = R.px(o.x); o.y = R.py(o.y);
      o.rotation = R.angUp(o.rotation ?? 0);
      break;
    case "circle":
      o.x = R.px(o.x); o.y = R.py(o.y);
      break;
    case "polygon": {
      const np = Array.isArray(o.points) ? o.points.slice() : [];
      for (let i = 0; i < np.length; i += 2) { np[i] = R.px(np[i]); np[i + 1] = R.py(np[i + 1]); }
      o.points = np;
      break;
    }
  }
  return o;
}

/* ───────────────────────── Background → Tile ───────────────────────── */

function _bgTileData(src, d, { elevation, sort, kind }) {
  return {
    texture: { src, fit: "fill", scaleX: 1, scaleY: 1 },
    x: d.sceneX, y: d.sceneY,
    width: d.sceneWidth, height: d.sceneHeight,
    rotation: 0,
    elevation,
    sort,
    locked: true,
    flags: { [MOD]: { managed: true, kind } },
  };
}

/**
 * Overlay the scene background (and foreground, if any) with full-scene Tiles that
 * CAN be transformed. We deliberately do NOT clear the scene's background/foreground
 * src: the opaque full-scene tile already covers the original (it sits above the
 * background mesh), and clearing the src would trigger a full canvas redraw that tears
 * down placeables mid-update — which crashes third-party `updateTile` hooks that read
 * `tile.object` (e.g. Levels' fog-of-war handler). Leaving the src intact also makes
 * "restore" trivial: just delete the managed tiles. Idempotent: gated on the presence
 * of a managed background tile; self-heals duplicate tiles from older runs.
 */
async function ensureBackgroundTile(scene) {
  const managed = Array.from(scene.tiles).filter((t) => _flagGet(t, MOD, "managed"));
  const bgTiles = managed.filter((t) => _flagGet(t, MOD, "kind") === "background");
  const fgTiles = managed.filter((t) => _flagGet(t, MOD, "kind") === "foreground");
  const dupIds = [...bgTiles.slice(1), ...fgTiles.slice(1)].map((t) => t.id);
  if (dupIds.length) {
    console.warn(`[${MOD}] removing ${dupIds.length} duplicate managed background tile(s)`);
    await scene.deleteEmbeddedDocuments("Tile", dupIds);
  }

  // Background tile elevation = the scene's backgroundElevation (Levels: flags.levels.backgroundElevation).
  // Foundry's native background is drawn at this elevation; the tile replacing it must match,
  // otherwise underwater content (tokens on water, elevation < 0) ends up BELOW the elevation-0 tile →
  // "under the map". No flag (non-Levels scene) → 0, as before.
  const _bgElevRaw = _flagGet(scene, "levels", "backgroundElevation");
  const _bgElev = Number.isFinite(Number(_bgElevRaw)) ? Number(_bgElevRaw) : 0;

  // Already converted (a managed background tile exists) → no need to create one. But pull its
  // elevation up to the current backgroundElevation (self-healing for scenes with the old hardcoded 0:
  // the elevation gets corrected on the next flip/reset).
  if (bgTiles.length) {
    const _fix = bgTiles
      .filter((t) => Number(t.elevation) !== _bgElev)
      .map((t) => ({ _id: t.id, elevation: _bgElev }));
    if (_fix.length) await scene.updateEmbeddedDocuments("Tile", _fix);
    return;
  }

  const bgSrc = scene.background?.src;
  const fgSrc = scene.foreground;
  const d = scene.dimensions;
  const toCreate = [];
  if (bgSrc) toCreate.push(_bgTileData(bgSrc, d, { elevation: _bgElev, sort: -9999, kind: "background" }));
  if (fgSrc && !fgTiles.length) toCreate.push(_bgTileData(fgSrc, d, { elevation: scene.foregroundElevation ?? 20, sort: 9999, kind: "foreground" }));
  if (!toCreate.length) return;

  await scene.createEmbeddedDocuments("Tile", toCreate);
}

/* ───────────────────────── Monk's Active Tiles coordinates ───────────────────────── */

// Reflect an explicit point {x, y, sceneId?, id?} on THIS scene. Entity/dynamic refs
// (non-empty id like a uuid / 'previous' / 'tile' / 'tagger:…') and points on other
// scenes are left untouched.
function _reflectMatPoint(o, R, sceneId) {
  if (!o || typeof o !== "object" || o.id) return o;
  if (typeof o.x !== "number" || typeof o.y !== "number") return o;
  if (o.sceneId && o.sceneId !== sceneId) return o;
  return { ...o, x: Math.round(R.px(o.x)), y: Math.round(R.py(o.y)) };
}

// Reflect coordinate fields inside Monk's Active Tiles actions (teleport / move / pan /
// ping …). Returns a new actions array, or null when there is nothing to change.
function _reflectMatActions(tileDoc, R, sceneId) {
  // Read the flag DIRECTLY (not getFlag): getFlag validates the scope against active modules and
  // THROWS if Monk's Active Tiles isn't installed/active — which would abort the whole flip. The raw
  // flags object is always readable, and the write below (u["flags.monks-active-tiles.actions"]) goes
  // through an update path that doesn't require the module to be active.
  const actions = tileDoc.flags?.["monks-active-tiles"]?.actions;
  if (!Array.isArray(actions) || !actions.length) return null;
  const KEYS = ["location", "position", "entity", "dest", "destination"];
  let any = false;
  const out = actions.map((a) => {
    if (!a?.data) return a;
    const data = { ...a.data };
    let changed = false;
    for (const k of KEYS) {
      const v = data[k];
      if (Array.isArray(v)) { data[k] = v.map((p) => _reflectMatPoint(p, R, sceneId)); changed = true; }
      else if (v && typeof v === "object") { data[k] = _reflectMatPoint(v, R, sceneId); changed = true; }
    }
    if (changed) { any = true; return { ...a, data }; }
    return a;
  });
  return any ? out : null;
}

/* ───────────────────────── Flip-state tracking (for Reset) ───────────────────────── */

// Net flip relative to the original ∈ {"none","h","v","r180"} — the Klein four-group
// (all involutions; composing two flips stays in the group). Stored in flags[MOD].flip.
function _modeAxes(m) { return m === "horizontal" ? [true, false] : m === "vertical" ? [false, true] : [true, true]; }
function _stateAxes(s) { return s === "h" ? [true, false] : s === "v" ? [false, true] : s === "r180" ? [true, true] : [false, false]; }
function _axesToState(x, y) { return x && y ? "r180" : x ? "h" : y ? "v" : "none"; }
function _composeFlip(state, mode) {
  const [sx, sy] = _stateAxes(state);
  const [mx, my] = _modeAxes(mode);
  return _axesToState(sx !== mx, sy !== my);
}
function _stateToMode(s) { return s === "h" ? "horizontal" : s === "v" ? "vertical" : "rotate180"; }

/* ───────────────────────── Non-active scene: hook safety ───────────────────────── */

// Embedded document types we update. On a NON-active scene the canvas placeables do not
// exist (doc.object === null), so third-party create/update hooks that touch the canvas
// object (e.g. Levels' fog-of-war `createTileFogMask(tile.object)`) throw. We temporarily
// remove those hooks for the duration of the flip and restore them afterwards. On the
// active scene we do nothing — the objects exist and the hooks must run normally.
const _CANVAS_DOC_TYPES = ["Tile", "Wall", "AmbientLight", "AmbientSound", "Note", "MeasuredTemplate", "Drawing", "Region"];

function _suspendHooks(names) {
  const saved = [];
  for (const name of names) {
    const arr = Hooks.events?.[name];
    if (Array.isArray(arr) && arr.length) saved.push([arr, arr.splice(0, arr.length)]);
  }
  return saved;
}
function _restoreHooks(saved) {
  for (const [arr, items] of saved) { try { arr.push(...items); } catch (_e) {} }
}

// Run `fn` with canvas-dependent embedded create/update/delete hooks suspended IF the
// scene is not the currently-viewed one.
async function _withCanvasHooksSafe(scene, fn) {
  const isActive = scene.id === (canvas?.scene?.id ?? null);
  if (isActive) return fn();
  const names = [];
  for (const t of _CANVAS_DOC_TYPES) names.push(`create${t}`, `update${t}`, `delete${t}`);
  const saved = _suspendHooks(names);
  try { return await fn(); }
  finally { _restoreHooks(saved); }
}

/* ───────────────────────── Reflection ───────────────────────── */

const _busy = new Set();

// Reflect every placeable (+ view position + Monk's coordinates) for the given mode.
// Does NOT convert the background or change flip-state — callers (flip/reset) handle that.
async function applyReflection(scene, mode) {
  const R = makeReflector(scene, mode);
  const arr = (coll) => Array.from(coll ?? []);

    // NOTE: Tokens are intentionally NOT flipped — they keep their position/facing.

    // Tiles (includes the managed background/foreground tiles): reflect the center,
    // flip the texture so the image content mirrors too, and reflect the rotation.
    const tileU = arr(scene.tiles).map((t) => {
      const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
      const u = { _id: t.id, x: Math.round(R.px(cx) - t.width / 2), y: Math.round(R.py(cy) - t.height / 2), rotation: R.angFlip(t.rotation ?? 0) };
      const tex = {};
      if (R.flipX) tex.scaleX = -(t.texture?.scaleX ?? 1);
      if (R.flipY) tex.scaleY = -(t.texture?.scaleY ?? 1);
      if (Object.keys(tex).length) u.texture = tex;
      // Monk's Active Tiles: reflect explicit point coordinates inside actions.
      const matActions = _reflectMatActions(t, R, scene.id);
      if (matActions) u["flags.monks-active-tiles.actions"] = matActions;
      return u;
    });

    // Walls: reflect both endpoints. One-way walls also need their direction swapped:
    // Foundry decides the blocked side via orient2dFast(a, b, point) (edge.mjs) — a
    // reflection flips that sign, so LEFT(1)/RIGHT(2) must swap to keep the same physical
    // side. A single flip (H xor V) is a reflection → swap; rotate180 (H and V) is a
    // rotation (det +1) → no swap. BOTH(0) is unaffected.
    const swapWallDir = R.flipX !== R.flipY;
    const wallU = arr(scene.walls).map((w) => {
      const c = w.c ?? [];
      const u = { _id: w.id, c: [R.px(c[0]), R.py(c[1]), R.px(c[2]), R.py(c[3])] };
      if (swapWallDir && (w.dir === 1 || w.dir === 2)) u.dir = w.dir === 1 ? 2 : 1;
      return u;
    });

    // Lights (point source + rotation).
    const lightU = arr(scene.lights).map((l) => ({ _id: l.id, x: R.px(l.x), y: R.py(l.y), rotation: R.angUp(l.rotation ?? 0) }));

    // Ambient sounds (point source).
    const soundU = arr(scene.sounds).map((s) => ({ _id: s.id, x: R.px(s.x), y: R.py(s.y) }));

    // Map notes (anchor point).
    const noteU = arr(scene.notes).map((n) => ({ _id: n.id, x: R.px(n.x), y: R.py(n.y) }));

    // Measured templates (origin point + direction).
    const tmplU = arr(scene.templates).map((t) => ({ _id: t.id, x: R.px(t.x), y: R.py(t.y), direction: R.angDir(t.direction ?? 0) }));

    // Drawings: reflect center, reflect rotation, and mirror local polygon/freehand points.
    const drawU = arr(scene.drawings).map((dw) => {
      const w = dw.shape?.width ?? 0, h = dw.shape?.height ?? 0;
      const cx = dw.x + w / 2, cy = dw.y + h / 2;
      const u = { _id: dw.id, x: Math.round(R.px(cx) - w / 2), y: Math.round(R.py(cy) - h / 2), rotation: R.angFlip(dw.rotation ?? 0) };
      const pts = dw.shape?.points;
      if (Array.isArray(pts) && pts.length) {
        const np = pts.slice();
        for (let i = 0; i < np.length; i += 2) { if (R.flipX) np[i] = w - np[i]; if (R.flipY) np[i + 1] = h - np[i + 1]; }
        u.shape = { points: np };
      }
      return u;
    });

    // Regions: reflect each shape's geometry.
    const regionU = arr(scene.regions).map((r) => {
      const obj = r.toObject();
      const shapes = (obj.shapes ?? []).map((s) => reflectRegionShape(s, R));
      const u = { _id: r.id, shapes };
      // ADM Levels ramp/stairs direction (degrees, vector v=(-sinθ,cosθ)): reflect it
      // like a facing vector (angUp). adm-levels' own preUpdateRegion hook only handles
      // ROTATION of the polygon, not reflection, so it leaves the direction unchanged.
      // Setting it explicitly here both fixes that and makes the hook skip (it bails
      // when the direction flag is already present in the same update).
      const dir = r.flags?.["adm-levels"]?.direction; // direct read — getFlag throws if adm-levels is inactive
      if (dir !== undefined && dir !== null) u["flags.adm-levels.direction"] = R.angUp(Number(dir) || 0);
      return u;
    });

    // Apply each collection independently (so one failing type doesn't block the rest).
    // ignoreLinks: tell Mass Edit (multi-token-edit) NOT to propagate a transform delta
    // to linked placeables — we already flip every placeable individually to its
    // mirrored position, so its translation/rotation propagation would double-apply
    // (and it cannot represent a reflection anyway). The links themselves are untouched.
    const apply = async (type, updates) => {
      if (!updates.length) return;
      try { await scene.updateEmbeddedDocuments(type, updates, { ignoreLinks: true }); }
      catch (e) { console.error(`[${MOD}] update ${type} failed`, e); }
    };
    await apply("Tile", tileU);
    await apply("Wall", wallU);
    await apply("AmbientLight", lightU);
    await apply("AmbientSound", soundU);
    await apply("Note", noteU);
    await apply("MeasuredTemplate", tmplU);
    await apply("Drawing", drawU);
    await apply("Region", regionU);

    // Default view position (scene.initial) — reflect if set. Done last; it is a scalar
    // scene update that does not tear down placeables (unlike a background change).
    const init = scene.initial ?? {};
    const initUpd = {};
    if (typeof init.x === "number") initUpd["initial.x"] = Math.round(R.px(init.x));
    if (typeof init.y === "number") initUpd["initial.y"] = Math.round(R.py(init.y));
    if (Object.keys(initUpd).length) {
      try { await scene.update(initUpd); } catch (e) { console.error(`[${MOD}] view position failed`, e); }
    }
}

/* ───────────────────────── Public ops: flip / reset ───────────────────────── */

async function flipScene(scene, mode) {
  if (!scene) return;
  if (!game.user?.isGM) { ui.notifications.warn(_t("Notify.GMOnly")); return; }
  if (_busy.has(scene.id)) { ui.notifications.info(_t("Notify.InProgress")); return; }
  _busy.add(scene.id);
  try {
    await _withCanvasHooksSafe(scene, async () => {
      await ensureBackgroundTile(scene);  // overlay background with a tile (once)
      await applyReflection(scene, mode);
    });
    await _flagSet(scene, MOD, "flip", _composeFlip(_flagGet(scene, MOD, "flip") || "none", mode));
    ui.notifications.info(_t("Notify.Done", { mode: _t(`Menu.${MODE_LABEL[mode]}`) }));
  } catch (e) {
    console.error(`[${MOD}] flip failed`, e);
    ui.notifications.error(_t("Notify.Error", { error: e?.message ?? e }));
  } finally {
    _busy.delete(scene.id);
  }
}

// Reset: restore the scene to its original orientation and remove the managed tiles.
// Each flip is its own inverse, so re-applying the net flip state un-flips everything;
// the original background (never nulled) reappears once the managed tiles are deleted.
async function resetScene(scene) {
  if (!scene) return;
  if (!game.user?.isGM) { ui.notifications.warn(_t("Notify.GMOnly")); return; }
  if (_busy.has(scene.id)) { ui.notifications.info(_t("Notify.InProgress")); return; }
  _busy.add(scene.id);
  try {
    const state = _flagGet(scene, MOD, "flip") || "none";
    const managedIds = Array.from(scene.tiles).filter((t) => _flagGet(t, MOD, "managed")).map((t) => t.id);
    if (state === "none" && !managedIds.length) { ui.notifications.info(_t("Notify.NothingToReset")); return; }
    await _withCanvasHooksSafe(scene, async () => {
      if (managedIds.length) await scene.deleteEmbeddedDocuments("Tile", managedIds, { ignoreLinks: true });
      if (state !== "none") await applyReflection(scene, _stateToMode(state));
    });
    if (_flagGet(scene, MOD, "flip")) await _flagDel(scene, MOD, "flip");
    ui.notifications.info(_t("Notify.Reset", { scene: scene.name }));
  } catch (e) {
    console.error(`[${MOD}] reset failed`, e);
    ui.notifications.error(_t("Notify.Error", { error: e?.message ?? e }));
  } finally {
    _busy.delete(scene.id);
  }
}

/* ───────────────────────── Hover submenu ───────────────────────── */

let _hideTimer = null;

function _removeSubmenu() {
  document.getElementById("asf-submenu")?.remove();
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}
function _scheduleHide() {
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(_removeSubmenu, 180);
}
function _cancelHide() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}

function _buildSubmenu(scene) {
  const menu = document.createElement("nav");
  menu.id = "asf-submenu";
  menu.className = "asf-submenu";
  const list = document.createElement("ul");
  menu.append(list);

  const addItem = (icon, labelKey, onClick, cls = "") => {
    const li = document.createElement("li");
    li.className = "asf-submenu-item" + (cls ? ` ${cls}` : "");
    li.innerHTML = `<i class="fa-solid ${icon} fa-fw"></i><span>${foundry.utils.escapeHTML(_t(labelKey))}</span>`;
    li.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      _removeSubmenu();
      ui.context?.close?.();
      onClick();
    });
    list.append(li);
  };

  addItem("fa-arrows-up-down", "Menu.FlipV", () => flipScene(scene, "vertical"));
  addItem("fa-arrows-left-right", "Menu.FlipH", () => flipScene(scene, "horizontal"));
  addItem("fa-rotate", "Menu.Rotate180", () => flipScene(scene, "rotate180"));

  const sep = document.createElement("li");
  sep.className = "asf-submenu-sep";
  list.append(sep);
  addItem("fa-arrow-rotate-left", "Menu.Reset", () => resetScene(scene), "asf-reset");

  menu.addEventListener("mouseenter", _cancelHide);
  menu.addEventListener("mouseleave", _scheduleHide);
  return menu;
}

let _submenuGen = 0;

function _showSubmenu(anchorEl, sceneId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const gen = ++_submenuGen;
  _removeSubmenu();
  const menu = _buildSubmenu(scene);
  if (gen !== _submenuGen) return;
  document.body.append(menu);

  const a = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 100;
  let left = a.right - 2;
  if (left + mw > window.innerWidth - 4) left = a.left - mw + 2;
  if (left < 4) left = 4;
  let top = a.top - 4;
  if (top + mh > window.innerHeight - 4) top = window.innerHeight - mh - 4;
  if (top < 4) top = 4;
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}

function _bindHover(entryEl, sceneId) {
  entryEl.addEventListener("mouseenter", () => { _cancelHide(); _showSubmenu(entryEl, sceneId); });
  entryEl.addEventListener("mouseleave", _scheduleHide);
}

/* ───────────────────────── ADMaps Tools sub-module descriptor ───────────────────────── */

export const TOOL = {
  id: "sceneFlip",
  name: "ADM_LEVELS.settings.sceneFlip.name",
  hint: "ADM_LEVELS.settings.sceneFlip.hint",
  replaces: ["admaps-scene-flip"],

  onReady({ isEnabled }) {
    // "Scene Flip" entry in the navbar scene context menu (active scene only, GM).
    Hooks.on("getSceneContextOptions", (app, items) => {
      if (!isEnabled()) return;
      if (!game.user?.isGM) return;
      const entry = {
        name: `${I18N}.Menu.Flip`, // ContextMenu localizes item.name itself
        icon: '<i class="fa-solid fa-left-right"></i>',
        condition: (li) => {
          const el = li?.dataset ? li : li?.[0];
          const sceneId = el?.dataset?.sceneId;
          if (!sceneId) return false;
          // Only offer "Scene Flip" for the currently-viewed scene (flipping a non-active
          // scene works via the API, but is hidden from the menu to avoid accidental clicks).
          if (sceneId !== (canvas?.scene?.id ?? null)) return false;
          requestAnimationFrame(() => {
            const elem = entry.element;
            if (elem && !elem.dataset.asfBound) {
              elem.dataset.asfBound = "1";
              elem.classList.add("asf-context-entry");
              _bindHover(elem, sceneId);
            }
          });
          return true;
        },
        callback: () => { _removeSubmenu(); }, // actions live in the hover submenu
      };
      items.push(entry);
    });

    // Close the hover submenu on outside click / scroll.
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest("#asf-submenu") && !ev.target.closest(".asf-context-entry")) _removeSubmenu();
    }, { passive: true });
    window.addEventListener("scroll", _removeSubmenu, { passive: true, capture: true });

    // Public API: on the ADMaps Tools container + globally (compatibility with external macros).
    const api = { flip: flipScene };
    const mod = game.modules.get("adm-levels");
    if (mod) (mod.api ??= {}).sceneFlip = api;
    globalThis.admapsSceneFlip = api;
  },
};
