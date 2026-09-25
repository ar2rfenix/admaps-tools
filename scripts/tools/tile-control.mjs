// modules/admaps-tile-control/scripts/main.mjs
// ADMaps Tile Control — scene tile management panel.
//
// Features:
//   • list of tiles on the current layer (background / foreground) by Z-order;
//   • click a row = control the tile + ISOLATION: other tiles temporarily stop
//     capturing the mouse, so an overlapped tile (under a larger one) can be
//     moved, scaled and rotated directly on the canvas;
//   • hover = highlight the tile on the scene;
//   • double click = zoom (pan the camera) to the tile;
//   • search across tile data.
// No Z-index drag sorting.

const MODULE_ID = "admaps-tile-control"; // FLAG namespace — KEPT as is (live savedWall/disabledBehaviors/admLevelsOff/linkedDisabled data on scenes — don't orphan it!)

// ⚠️ getFlag/setFlag/unsetFlag with the namespace of a REMOVED module throw "scope not valid or not active".
// We access the flags DIRECTLY (data under the old namespace is intact; same behavior, minus the scope validation).
const _flagGet = (doc, ns, key) => foundry.utils.getProperty(doc?.flags ?? {}, `${ns}.${key}`);
const _flagSet = (doc, ns, key, val) => doc.update({ [`flags.${ns}.${key}`]: val });
const _flagDel = (doc, ns, key) => doc.update({ [`flags.${ns}.-=${key}`]: null });

const ASSET_ID = "adm-levels";           // ADMaps Tools container module — path to the template/CSS
const WINDOW_ID = "admaps-tile-control"; // DOM/Application id — CSS #admaps-tile-control works without changes
const HL_NAME = "admtc-hover-highlight"; // name of the PIXI highlight sprite
const PANEL_WIDTH = 345; // fixed window width — fits exactly 3 tiles of 100px
const MASS_EDIT_ID = "multi-token-edit"; // Mass Edit module — links (attached) walls/regions to a tile
const ADM_LEVELS_ID = "adm-levels"; // sibling module — region elevation magnet (plateau/stairs)

/** Find the open panel (singleton). */
function findPanel() {
  return Object.values(ui.windows).find((w) => w.id === WINDOW_ID) ?? null;
}

class ADMTileControlPanel extends Application {
  /** @type {Map<string,string>|null} saved eventMode values for lifting isolation */
  #savedModes = null;
  /** @type {boolean} are we showing the foreground layer? */
  #foreground = false;
  /** @type {Set<string>|null} pick filter — show only these tile ids, or null for all */
  #pickFilter = null;
  /** @type {((ev: PointerEvent) => void)|null} canvas pointerdown handler (records click start) */
  #onCanvasDown = null;
  /** @type {((ev: PointerEvent) => void)|null} canvas pointerup handler (performs the pick) */
  #onCanvasPick = null;
  /** @type {HTMLCanvasElement|null} the DOM canvas the pick handlers are attached to */
  #pickView = null;
  /** @type {((ev: KeyboardEvent) => void)|null} document keydown handler (Alt+↑/↓ = sort ±1) */
  #onKeyDown = null;
  /** @type {HTMLElement|null} open Mass Edit context menu element */
  #ctxMenu = null;
  /** @type {((ev: PointerEvent) => void)|null} outside-click closer for the context menu */
  #ctxOutside = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: WINDOW_ID,
      title: "ADMaps Tile Control",
      template: `modules/${ASSET_ID}/templates/tile-control-panel.hbs`,
      classes: ["admtc-panel"],
      width: PANEL_WIDTH,
      height: window.innerHeight - 8,
      top: 4,
      left: window.innerWidth - PANEL_WIDTH - 4,
      resizable: false,
    });
  }

  getData() { return {}; }

  /* ───────── data ───────── */

  #layerTiles() {
    const fgElev = canvas.primary?.foreground?.elevation;
    const all = canvas.tiles?.placeables ?? [];
    return all.filter((t) =>
      this.#foreground
        ? t.document.elevation === fgElev
        : t.document.elevation !== fgElev
    );
  }

  #rebuild() {
    const listEl = this.element?.find?.(".admtc-list")?.[0];
    if (!listEl) return;
    const term = String(this.element.find(".admtc-search").val() || "").toLowerCase();
    // Sort by file name — identical tiles (trees, rocks) end up grouped together.
    const nameOf = (t) => (t.document.texture?.src?.split("/").pop() || t.id).toLowerCase();
    let tiles = [...this.#layerTiles()].filter((t) => t.visible);
    if (this.#pickFilter) tiles = tiles.filter((t) => this.#pickFilter.has(t.id));
    const ordered = tiles.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    listEl.replaceChildren(...ordered.map((t) => this.#row(t, term)));
    this.setPosition({ height: window.innerHeight - 8 });
  }

  #row(tile, term) {
    const src = tile.document.texture?.src ?? "";
    const fileName = src.split("/").pop() || tile.id;
    const isVideo = (src.split(".").pop() || "").toLowerCase() === "webm";

    let dimmed = false;
    if (term) {
      const blob = JSON.stringify(tile.document.toJSON()).toLowerCase();
      dimmed = !blob.includes(term);
    }

    const li = document.createElement("li");
    li.className = ["admtc-row",
      tile.controlled ? "is-controlled" : "",
      dimmed ? "is-dimmed" : ""].filter(Boolean).join(" ");
    li.dataset.tileId = tile.id;
    li.title = fileName;

    const media = document.createElement(isVideo ? "video" : "img");
    media.className = "admtc-media";
    if (isVideo) { media.autoplay = true; media.loop = true; media.muted = true; }
    media.src = src;

    const name = document.createElement("span");
    name.className = "admtc-name";
    name.textContent = fileName;

    const idx = document.createElement("span");
    idx.className = "admtc-index";
    idx.textContent = tile.document.sort ?? 0;

    li.appendChild(media);
    li.appendChild(idx);
    li.appendChild(name);
    return li;
  }

  /* ───────── hovered-tile highlight ───────── */

  #highlightOn(tile) {
    this.#highlightOff();
    const mesh = tile?.mesh;
    if (!mesh?.texture?.baseTexture) return;
    const spr = PIXI.Sprite.from(mesh.texture);
    spr.name = HL_NAME;
    spr.anchor.set(mesh.anchor.x, mesh.anchor.y);
    spr.width = mesh.width;
    spr.height = mesh.height;
    spr.scale = mesh.scale;
    spr.position = tile.center;
    spr.angle = mesh.angle;
    spr.alpha = 0.45;
    spr.tint = 0x4cc2ff;
    canvas.controls?.debug?.addChild(spr);
  }

  #highlightOff() {
    const old = canvas.controls?.debug?.children?.find((c) => c.name === HL_NAME);
    if (old) old.destroy();
  }

  /* ───────── isolation of the selected tile ───────── */

  #isolate(tile) {
    this.#deisolate();
    if (!tile) return;
    this.#savedModes = new Map();
    for (const t of (canvas.tiles?.placeables ?? [])) {
      if (t === tile) continue;
      this.#savedModes.set(t.id, t.eventMode);
      t.eventMode = "none"; // doesn't capture the mouse → clicks pass to the selected tile
    }
    tile.eventMode = "static";
  }

  #deisolate() {
    if (!this.#savedModes) return;
    for (const [id, mode] of this.#savedModes) {
      const t = canvas.tiles?.get(id);
      if (t) t.eventMode = mode ?? "static";
    }
    this.#savedModes = null;
  }

  /**
   * Re-apply isolation after Foundry refreshes a tile. Foundry resets eventMode in
   * its refresh cycle (e.g. when Alt triggers highlightObjects), which would silently
   * undo isolation and let an overlapping tile steal the mouse during resize/drag.
   */
  reapplyIsolation(tile) {
    if (this.#savedModes?.has(tile.id) && tile.eventMode !== "none") {
      tile.eventMode = "none";
    }
  }

  /* ───────── public update hooks ───────── */

  /** Sync the highlight of selected rows; lift isolation when nothing is selected. */
  syncControlled() {
    const root = this.element;
    if (!root) return;
    root.find(".is-controlled").removeClass("is-controlled");
    let any = false;
    for (const t of (canvas.tiles?.placeables ?? [])) {
      if (!t.controlled) continue;
      any = true;
      root.find(`[data-tile-id="${t.id}"]`).addClass("is-controlled");
    }
    if (!any) this.#deisolate();
  }

  rebuild() { this.#rebuild(); }

  switchLayer() {
    this.#foreground = !!$(`li[data-tool="foreground"]`).hasClass("active");
    this.#pickFilter = null; // pick filter is tied to a layer/view — reset on layer switch
    this.#rebuild();
  }

  /* ───────── pick tiles under a canvas click ───────── */

  /** Is the world point (px,py) inside this tile's (rotated) rectangle? */
  #pointInTile(tile, px, py) {
    const d = tile.document;
    const w = d.width, h = d.height;
    if (!w || !h) return false;
    const rot = (d.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(-rot), sin = Math.sin(-rot);
    const dx = px - (d.x + w / 2), dy = py - (d.y + h / 2);
    const lx = dx * cos - dy * sin + w / 2;
    const ly = dx * sin + dy * cos + h / 2;
    return lx >= 0 && lx <= w && ly >= 0 && ly <= h;
  }

  /** Listen for canvas clicks and filter the list to the tiles under the point. */
  #installCanvasPick() {
    this.#removeCanvasPick();
    const view = canvas?.app?.view ?? canvas?.app?.canvas;
    if (!view) return;
    let downX = 0, downY = 0, downOk = false;
    this.#onCanvasDown = (ev) => {
      // Plain left click only — modifiers drive native Foundry ops (Alt = proportional
      // resize, Shift = multi-select, …), so we must not interfere with them.
      downOk = ev.button === 0 && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
      downX = ev.clientX;
      downY = ev.clientY;
    };
    this.#onCanvasPick = (ev) => {
      if (ev.button !== 0 || !downOk) return;
      downOk = false;
      // Ignore if the pointer moved between down and up — that's a drag/resize, not a click.
      if (Math.abs(ev.clientX - downX) > 6 || Math.abs(ev.clientY - downY) > 6) return;
      if (!canvas?.ready || canvas.activeLayer !== canvas.tiles) return;
      const global = new PIXI.Point();
      canvas.app.renderer.events.mapPositionToPoint(global, ev.clientX, ev.clientY);
      const p = canvas.stage.toLocal(global);
      const hits = this.#layerTiles()
        .filter((t) => t.visible && this.#pointInTile(t, p.x, p.y));
      if (!hits.length) return;
      this.#pickFilter = new Set(hits.map((t) => t.id));
      this.#rebuild();
    };
    // Capture phase; we never preventDefault/stopPropagation, so native tile
    // interactions (drag, resize, rotate) keep working untouched.
    this.#pickView = view;
    view.addEventListener("pointerdown", this.#onCanvasDown, true);
    view.addEventListener("pointerup", this.#onCanvasPick, true);
  }

  #removeCanvasPick() {
    // Remove from the exact view we attached to (canvas may have been rebuilt since).
    if (this.#pickView) {
      if (this.#onCanvasDown) this.#pickView.removeEventListener("pointerdown", this.#onCanvasDown, true);
      if (this.#onCanvasPick) this.#pickView.removeEventListener("pointerup", this.#onCanvasPick, true);
    }
    this.#onCanvasDown = null;
    this.#onCanvasPick = null;
    this.#pickView = null;
  }

  /** Alt+↑ / Alt+↓ — change the controlled tile(s) sort (z-order) by +1 / -1. */
  #installKeys() {
    this.#removeKeys();
    this.#onKeyDown = (ev) => {
      if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      if (!canvas?.ready || canvas.activeLayer !== canvas.tiles) return;
      const controlled = canvas.tiles.controlled;
      if (!controlled.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const delta = ev.key === "ArrowUp" ? 1 : -1;
      const updates = controlled.map((t) => ({ _id: t.id, sort: (t.document.sort ?? 0) + delta }));
      canvas.scene?.updateEmbeddedDocuments("Tile", updates);
    };
    // Capture phase + stopPropagation: intercept before Foundry's arrow-key handling.
    document.addEventListener("keydown", this.#onKeyDown, true);
  }

  #removeKeys() {
    if (this.#onKeyDown) document.removeEventListener("keydown", this.#onKeyDown, true);
    this.#onKeyDown = null;
  }

  /** Clear the pick filter (and the search box) → show all tiles again. */
  clearPick() {
    this.#pickFilter = null;
    this.element?.find?.(".admtc-search")?.val("");
    this.#rebuild();
  }

  /** canvasReady: re-attach the listener (canvas may have been rebuilt) and reset the filter. */
  onCanvasReady() {
    this.#installCanvasPick();
    this.clearPick();
  }

  /* ───────── Mass Edit integration: attached walls/regions ───────── */

  #massEditActive() { return !!game.modules.get(MASS_EDIT_ID)?.active; }

  /** Walls & Regions linked to the tile via Mass Edit (recursive resolver when available). */
  #linkedWallsRegions(tileDoc) {
    const isWR = (d) => d.documentName === "Wall" || d.documentName === "Region";
    // Prefer Mass Edit's own resolver — it walks chained link graphs correctly.
    const linker = game.modules.get(MASS_EDIT_ID)?.api?.linker;
    if (linker?.getLinkedDocuments) {
      try { return Array.from(linker.getLinkedDocuments(tileDoc)).filter(isWR); } catch (_) { /* fall back */ }
    }
    // Fallback: single-level match on a shared link id.
    const myLinks = tileDoc.flags?.[MASS_EDIT_ID]?.links;
    if (!myLinks?.length) return [];
    const myIds = new Set(myLinks.map((l) => l.id));
    const scene = tileDoc.parent;
    const out = [];
    for (const dn of ["Wall", "Region"]) {
      for (const d of scene.getEmbeddedCollection(dn)) {
        if (d.flags?.[MASS_EDIT_ID]?.links?.some((l) => myIds.has(l.id))) out.push(d);
      }
    }
    return out;
  }

  /** Disable attached walls (movement) and regions (behaviors) so they don't affect tokens. */
  async #disableLinked(tileDoc) {
    const linked = this.#linkedWallsRegions(tileDoc);
    const scene = tileDoc.parent;
    // Disable walls fully: movement, sight, sound and light all pass through (NONE = 0).
    const wallUpdates = linked
      .filter((d) => d.documentName === "Wall" && !d.flags?.[MODULE_ID]?.savedWall)
      .map((d) => ({
        _id: d.id,
        move: 0, sight: 0, sound: 0, light: 0,
        [`flags.${MODULE_ID}.savedWall`]: { move: d.move, sight: d.sight, sound: d.sound, light: d.light },
      }));
    if (wallUpdates.length) await scene.updateEmbeddedDocuments("Wall", wallUpdates);
    for (const region of linked.filter((d) => d.documentName === "Region")) {
      // Generic Foundry regions: disable their behaviors.
      const toDisable = region.behaviors.filter((b) => !b.disabled);
      if (toDisable.length) {
        await region.updateEmbeddedDocuments("RegionBehavior", toDisable.map((b) => ({ _id: b.id, disabled: true })));
        await _flagSet(region, MODULE_ID, "disabledBehaviors", toDisable.map((b) => b.id));
      }
      // adm-levels regions (plateau/stairs): stop them magnetising token elevation.
      if (region.flags?.[ADM_LEVELS_ID]?.type && !_flagGet(region, ADM_LEVELS_ID, "disabled")) {
        await _flagSet(region, ADM_LEVELS_ID, "disabled", true);
        await _flagSet(region, MODULE_ID, "admLevelsOff", true);
      }
    }
    await _flagSet(tileDoc, MODULE_ID, "linkedDisabled", true);
  }

  /** Re-enable previously disabled attached walls/regions (restore saved state). */
  async #enableLinked(tileDoc) {
    const linked = this.#linkedWallsRegions(tileDoc);
    const scene = tileDoc.parent;
    const wallUpdates = [];
    for (const d of linked.filter((x) => x.documentName === "Wall")) {
      const sw = d.flags?.[MODULE_ID]?.savedWall;
      if (sw) {
        wallUpdates.push({
          _id: d.id, move: sw.move, sight: sw.sight, sound: sw.sound, light: sw.light,
          [`flags.${MODULE_ID}.-=savedWall`]: null,
        });
      } else if (d.flags?.[MODULE_ID]?.savedMove != null) {
        // Legacy: walls disabled by an older move-only version.
        wallUpdates.push({ _id: d.id, move: d.flags[MODULE_ID].savedMove, [`flags.${MODULE_ID}.-=savedMove`]: null });
      }
    }
    if (wallUpdates.length) await scene.updateEmbeddedDocuments("Wall", wallUpdates);
    for (const region of linked.filter((d) => d.documentName === "Region")) {
      const ids = region.flags?.[MODULE_ID]?.disabledBehaviors;
      if (ids?.length) {
        await region.updateEmbeddedDocuments("RegionBehavior", ids.map((id) => ({ _id: id, disabled: false })));
        await _flagDel(region, MODULE_ID, "disabledBehaviors");
      }
      // Restore adm-levels elevation magnet only if we were the ones who turned it off.
      if (_flagGet(region, MODULE_ID, "admLevelsOff")) {
        await _flagDel(region, ADM_LEVELS_ID, "disabled");
        await _flagDel(region, MODULE_ID, "admLevelsOff");
      }
    }
    await _flagDel(tileDoc, MODULE_ID, "linkedDisabled");
  }

  /** Right-click menu over a list row (Mass Edit active + tile has attached walls/regions). */
  #showMassEditMenu(tile, ev) {
    this.#closeMassEditMenu();
    const tileDoc = tile.document;
    const linked = this.#linkedWallsRegions(tileDoc);
    if (!linked.length) {
      ui.notifications.info("No walls/regions are attached to this tile.");
      return;
    }
    const disabled = !!_flagGet(tileDoc, MODULE_ID, "linkedDisabled");
    const menu = document.createElement("div");
    menu.className = "admtc-ctx";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "admtc-ctx-item";
    btn.textContent = disabled ? "Enable Mass Edit" : "Disable attached walls/regions";
    btn.addEventListener("click", async () => {
      this.#closeMassEditMenu();
      if (disabled) await this.#enableLinked(tileDoc);
      else await this.#disableLinked(tileDoc);
      this.#rebuild();
    });
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const ox = ev.clientX ?? ev.originalEvent?.clientX ?? 0;
    const oy = ev.clientY ?? ev.originalEvent?.clientY ?? 0;
    menu.style.left = `${Math.min(ox, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(oy, window.innerHeight - menu.offsetHeight - 4)}px`;
    this.#ctxMenu = menu;
    this.#ctxOutside = (e) => { if (!menu.contains(e.target)) this.#closeMassEditMenu(); };
    setTimeout(() => document.addEventListener("pointerdown", this.#ctxOutside, true), 0);
  }

  #closeMassEditMenu() {
    if (this.#ctxOutside) {
      document.removeEventListener("pointerdown", this.#ctxOutside, true);
      this.#ctxOutside = null;
    }
    if (this.#ctxMenu) { this.#ctxMenu.remove(); this.#ctxMenu = null; }
  }

  /* ───────── lifecycle ───────── */

  activateListeners(html) {
    super.activateListeners(html);
    this.switchLayer();
    const self = this;

    html.on("pointerenter", ".admtc-row", function () {
      self.#highlightOn(canvas.tiles.get(this.dataset.tileId));
      this.classList.add("is-hover");
    });
    html.on("pointerleave", ".admtc-row", function () {
      self.#highlightOff();
      this.classList.remove("is-hover");
    });
    html.on("click", ".admtc-row", function (ev) {
      const tile = canvas.tiles.get(this.dataset.tileId);
      if (!tile) return;
      tile.control({ releaseOthers: !ev.shiftKey });
      self.#isolate(tile);
      // Pan to the tile, but not while showing tiles-under-click (camera is already there).
      if (!self.#pickFilter) canvas.animatePan({ x: tile.center.x, y: tile.center.y });
    });
    html.on("dblclick", ".admtc-row", function () {
      const tile = canvas.tiles.get(this.dataset.tileId);
      if (!tile) return;
      // Zoom the camera to the tile: fit it into the screen with a small margin.
      const [sw, sh] = canvas.screenDimensions;
      const fit = Math.min(sw / tile.document.width, sh / tile.document.height) * 0.9;
      const scale = Math.max(0.1, Math.min(CONFIG.Canvas.maxZoom ?? 3, fit));
      canvas.animatePan({ x: tile.center.x, y: tile.center.y, scale });
    });
    html.on("input", ".admtc-search", () => this.#rebuild());
    html.on("click", ".admtc-clear", () => this.clearPick());
    html.on("contextmenu", ".admtc-row", function (ev) {
      ev.preventDefault();
      // GM-only (writes walls/regions); requires Mass Edit installed.
      if (!game.user.isGM || !self.#massEditActive()) return;
      const tile = canvas.tiles.get(this.dataset.tileId);
      if (tile) self.#showMassEditMenu(tile, ev);
    });

    this.#installCanvasPick();
    this.#installKeys();
    this.#rebuild();
  }

  setPosition(options = {}) {
    // Docked panel at the right edge: fixed width/position, full height.
    return super.setPosition({
      ...options,
      width: PANEL_WIDTH,
      height: window.innerHeight - 8,
      top: 4,
      left: window.innerWidth - PANEL_WIDTH - 4,
    });
  }

  async close(options) {
    this.#removeCanvasPick();
    this.#removeKeys();
    this.#closeMassEditMenu();
    this.#deisolate();
    this.#highlightOff();
    return super.close(options);
  }
}

/* ───────── ADMaps Tools sub-module descriptor ───────── */

export const TOOL = {
  id: "tileControl",
  name: "ADM_LEVELS.settings.tileControl.name",
  hint: "ADM_LEVELS.settings.tileControl.hint",
  replaces: ["admaps-tile-control"],

  onReady({ isEnabled }) {
    // Button in the tile tools (only when the checkbox is enabled).
    Hooks.on("getSceneControlButtons", (controls) => {
      if (!isEnabled()) return;
      const tools = controls?.tiles?.tools;
      if (!tools) return;
      tools.admapsTileControl = {
        name: "admapsTileControl",
        title: "ADMaps Tile Control",
        icon: "fas fa-layer-group",
        button: true,
        onChange: () => {
          const p = findPanel();
          if (!p?.rendered) new ADMTileControlPanel().render(true);
        },
      };
    });
    // Keep the panel list up to date (these only take effect while the panel is open).
    Hooks.on("renderSceneControls", () => { findPanel()?.switchLayer?.(); });
    Hooks.on("canvasReady", () => { findPanel()?.onCanvasReady?.(); }); // new scene → re-attach + reset
    Hooks.on("createTile", () => { findPanel()?.rebuild?.(); });
    Hooks.on("deleteTile", () => { findPanel()?.rebuild?.(); });
    Hooks.on("updateTile", () => { findPanel()?.rebuild?.(); });
    Hooks.on("controlTile", () => { findPanel()?.syncControlled?.(); });
    Hooks.on("refreshTile", (tile) => { findPanel()?.reapplyIsolation?.(tile); }); // keep isolation through Foundry refresh (Alt-highlight)
    Hooks.on("levelsUiChangeLevel", () => { findPanel()?.switchLayer?.(); });
  },
};
