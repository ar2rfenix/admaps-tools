// modules/adm-levels/scripts/tools/tile-scroll.mjs
// ADMaps Tools — «Tile scroll».
// A lightweight own alternative to parallax-tiles / tile-scroll: animated scrolling of the tile
// texture over time (direction in degrees + speed) + optional feathering of the quad edges to
// transparency (so scrolling has no hard cutoff at the tile border).
//
// Scrolling is a vertex shader extending the core PrimaryBaseSamplerShader (keeps
// occlusion/lighting). Texture wrap REPEAT → seamless tiling while scrolling. The animation runs
// by itself: the primary group renders every frame → the shader's _preRender moves the UV over time.
// Edge feathering is a separate PIXI filter on the mesh (multiplies alpha by a falloff to the 4 edges).
//
// Settings live in the tile config tab, inside a spoiler (<details>), to avoid clutter.

const MODULE_ID = "adm-levels";
const FLAG = "tileScroll"; // flags.adm-levels.tileScroll.{enabled,direction,speed,feather,featherWidth}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll shader
// ─────────────────────────────────────────────────────────────────────────────
let _ScrollShader = null;
function _scrollShaderClass() {
  if (_ScrollShader) return _ScrollShader;
  const Base = foundry.canvas.rendering.shaders.PrimaryBaseSamplerShader;

  class AdmTileScrollShader extends Base {
    static classPluginName = null; // do not batch — own shader

    // Pin enabled: do not let the mesh switch to the batch plugin (otherwise the scroll vertex
    // shader and occlusion would be silently bypassed). Mirrors the reference module's guard.
    get enabled() { return true; }
    set enabled(v) {}

    static get vertexShader() {
      return `#version 300 es

      ${this.GLSL1_COMPATIBILITY_VERTEX}

      precision ${PIXI.settings.PRECISION_VERTEX} float;

      in vec2 aVertexPosition;
      in vec2 aTextureCoord;

      uniform vec2 screenDimensions;

      ${this._vertexShader}

      uniform mat3 projectionMatrix;

      uniform vec2 admScrollOff;
      uniform bool admWorld;
      uniform mat3 admInvWorld;
      uniform vec2 admPatSize;

      out vec2 vUvs;
      out vec2 vScreenCoord;
      out vec2 vAdmTileUv;

      void main() {
        vec2 vertexPosition;
        vec2 textureCoord;
        _main(vertexPosition, textureCoord);
        if (admWorld) {
          // Pattern mode: vertexPosition is in screen space (non-batched shader); map it back to
          // scene coordinates and repeat the image at its own pixel size - like CSS
          // background-repeat with background-attachment: fixed, anchored to the scene.
          vec2 scenePos = (admInvWorld * vec3(vertexPosition, 1.0)).xy;
          vUvs = (scenePos + admScrollOff) / admPatSize;
        } else {
          vUvs = aTextureCoord + admScrollOff;
        }
        vAdmTileUv = aTextureCoord; // local 0..1 across the quad (no scroll) — for feather
        gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vScreenCoord = vertexPosition / screenDimensions;
      }`;
    }

    // Feather is written straight into the core fragment shader (super.fragmentShader):
    // we add a varying + uniforms and multiply fragColor (premultiplied alpha) by a smooth falloff
    // to the 4 edges using the EXACT local coord vAdmTileUv (0 right at the edge → true
    // transparency). Insertions go at the base's stable anchors (in vec2 vScreenCoord; and
    // fragColor = _main();). We multiply BEFORE occlusion — alpha multipliers commute.
    // Wavy edge: each side is pushed inwards by its OWN 1D fractal noise (5 octaves) taken along
    // that side, so every side's contour is a graph over the side → no islands and no holes (a 2D
    // noise gave detached blobs and a smeared, dirty-looking fade). Sides are joined with a smooth
    // min, so corners are rounded instead of spiking. The push only goes inwards → alpha is 0 on
    // the tile border. Tuned on previews: swing 0.7 feather widths, fade 0.25, smooth-min 0.6,
    // wavelength = the feather band. Noise is evaluated only near its own side (cost ~1 fbm/pixel).
    static get fragmentShader() {
      return super.fragmentShader
        .replace(
          "in vec2 vScreenCoord;",
          `in vec2 vScreenCoord;
      in highp vec2 vAdmTileUv;
      uniform bool admFeatherOn;
      uniform float admFeatherW;
      uniform int admEdgeStyle;
      uniform highp vec2 admTileSize;
      uniform highp float admWaveLen;
      uniform highp vec2 admWaveSeed;
      highp float admHash(highp vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      highp float admNoise(highp vec2 p) {
        highp vec2 i = floor(p);
        highp vec2 f = p - i;
        highp vec2 u = f * f * (3.0 - 2.0 * f);
        highp float a = admHash(i);
        highp float b = admHash(i + vec2(1.0, 0.0));
        highp float c = admHash(i + vec2(0.0, 1.0));
        highp float d = admHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      highp float admFbm(highp vec2 p) {
        highp float v = 0.0;
        highp float a = 0.5;
        for (int k = 0; k < 5; k++) { v += a * admNoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
        return v / 0.96875;
      }
      highp float admEdgeN(highp float t, highp float row) {
        return clamp((admFbm(vec2(t, row)) - 0.5) * 1.6 + 0.5, 0.0, 1.0);
      }
      highp float admSmin(highp float a, highp float b, highp float k) {
        highp float h = max(k - abs(a - b), 0.0) / k;
        return min(a, b) - h * h * k * 0.25;
      }`
        )
        .replace(
          "fragColor = _main();",
          `fragColor = _main();
        if (admFeatherOn) {
          highp vec2 admd = min(vAdmTileUv, vec2(1.0) - vAdmTileUv);
          highp float adme = min(admd.x, admd.y);
          highp float admFade = admFeatherW;
          if (admEdgeStyle > 0) {
            highp float admW = admFeatherW;
            highp vec2 admt = vAdmTileUv * admTileSize / admWaveLen;   // position along the sides, in feather bands
            highp float admX = admWaveSeed.x;
            highp float admS = admWaveSeed.y;
            highp float admU = vAdmTileUv.x;
            highp float admV = vAdmTileUv.y;
            highp float eL;
            highp float eR;
            highp float eT;
            highp float eB;
            if (admEdgeStyle == 1) {
              // Torn: all four sides alike.
              highp float admLim = admW * 1.5;
              eL = admU < admLim ? admU - admW * 0.7 * admEdgeN(admt.y + admX, admS) : 1.0;
              eR = 1.0 - admU < admLim ? 1.0 - admU - admW * 0.7 * admEdgeN(admt.y + admX, admS + 3.1) : 1.0;
              eT = admV < admLim ? admV - admW * 0.7 * admEdgeN(admt.x + admX, admS + 6.2) : 1.0;
              eB = 1.0 - admV < admLim ? 1.0 - admV - admW * 0.7 * admEdgeN(admt.x + admX, admS + 9.3) : 1.0;
            } else {
              // Brush stroke from right to left: the right end is torn. The left end follows the user's
              // sketch: it recedes near the top and bottom (0.3 W) and bulges out in the middle (plateau
              // over 32-68% of the height, 12% shoulders), textured by the same kind of waves at twice
              // the frequency (0.35 W) so it does not look too even. Top and bottom are nearly straight.
              highp float admBulge = smoothstep(0.2, 0.32, admV) * (1.0 - smoothstep(0.68, 0.8, admV));
              eL = admU < admW * 1.5 ? admU - admW * (0.3 * (1.0 - admBulge) + 0.35 * admEdgeN(admt.y * 2.0 + admX, admS + 3.1)) : 1.0;
              eR = 1.0 - admU < admW * 1.5 ? 1.0 - admU - admW * 0.7 * admEdgeN(admt.y + admX, admS + 3.1) : 1.0;
              eT = admV < admW ? admV - admW * 0.3 * admEdgeN(admt.x / 3.0 + admX, admS + 6.2) : 1.0;
              eB = 1.0 - admV < admW ? 1.0 - admV - admW * 0.3 * admEdgeN(admt.x / 3.0 + admX, admS + 9.3) : 1.0;
            }
            highp float admK = admW * 0.6;
            adme = admSmin(admSmin(eL, eR, admK), admSmin(eT, eB, admK), admK);
            admFade = admW * 0.25;
          }
          fragColor *= smoothstep(0.0, admFade, adme);
        }`
        );
    }

    static defaultUniforms = {
      ...Base.defaultUniforms,
      admScrollOff: [0, 0],
      admWorld: false,
      admInvWorld: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      admPatSize: [1, 1],
      admFeatherOn: false,
      admFeatherW: 0.12,
      admEdgeStyle: 0,
      admTileSize: [1, 1],
      admWaveLen: 100,
      admWaveSeed: [0, 0],
    };

    _preRender(mesh, renderer) {
      super._preRender(mesh, renderer);
      const f = this.tile?.document?.flags?.[MODULE_ID]?.[FLAG] ?? {};
      // The UV offset is computed in JS (double) and EACH component is reduced mod 1. Under REPEAT
      // a shift by a whole 1.0 = exactly one texture tile → seamless for ANY direction,
      // and small 0..1 values are exact in float32. (serverTime ~1.75e12 fed directly into float32
      // would «freeze» for ~2 min, then jump — because the ULP step is ≈131072.) serverTime is in sync
      // across clients → the scroll phase is the same for everyone.
      const t = game.time?.serverTime ?? canvas.app.ticker.lastTime;
      const dir = Math.toRadians(Number(f.direction) || 0);
      const world = !!f.world;
      this.uniforms.admWorld = world;
      if (world) {
        // «Repeat on scene»: speed is in scene pixels per second, the offset is reduced mod the
        // image size (same float32 reasoning as below) → any tile size, same speed, seamless joins.
        // The tile's own texture scale (Appearance tab) sizes the PATTERN here; the window stays the
        // whole tile (see _fitPatternWindow).
        const bt = mesh.texture?.baseTexture;
        const tex = this.tile?.document?.texture;
        const pw = (bt?.realWidth || mesh.texture?.orig?.width || 1) * (Math.abs(Number(tex?.scaleX)) || 1);
        const ph = (bt?.realHeight || mesh.texture?.orig?.height || 1) * (Math.abs(Number(tex?.scaleY)) || 1);
        // Pattern rotation: pattern space = R(−θ)·scene (θ clockwise, like Foundry rotations), about the
        // scene origin → tiles with the same angle still join seamlessly. The scroll direction stays in
        // scene degrees: the scene-space offset is rotated into pattern space before the mod.
        const rot = Math.toRadians(Number(f.patternRotation) || 0);
        const rc = Math.cos(rot), rs = Math.sin(rot);
        const pxPerMs = (Number(f.speed) || 0) / 1000;
        const owx = t * pxPerMs * Math.cos(dir);
        const owy = t * pxPerMs * Math.sin(dir);
        let ox = rc * owx + rs * owy;
        let oy = -rs * owx + rc * owy;
        ox -= Math.floor(ox / pw) * pw;
        oy -= Math.floor(oy / ph) * ph;
        this.uniforms.admScrollOff = [ox, oy];
        this.uniforms.admPatSize = [pw, ph];
        // Screen → scene: inverse of the transform the tile mesh is drawn with (pan/zoom), then the rotation.
        const wt = (mesh.parent ?? canvas.stage).worldTransform;
        const inv = (this._admInv ??= new PIXI.Matrix()).copyFrom(wt).invert();
        if (rot) {
          const { a, b, c, d, tx, ty } = inv;
          inv.a = rc * a + rs * b;    inv.b = -rs * a + rc * b;
          inv.c = rc * c + rs * d;    inv.d = -rs * c + rc * d;
          inv.tx = rc * tx + rs * ty; inv.ty = -rs * tx + rc * ty;
        }
        this.uniforms.admInvWorld = inv.toArray(true, this._admInvArr ??= new Float32Array(9));
      } else {
        const spd = (Number(f.speed) || 0) / 10000;
        let ox = t * spd * Math.cos(dir);
        let oy = t * spd * Math.sin(dir);
        ox -= Math.floor(ox);
        oy -= Math.floor(oy);
        this.uniforms.admScrollOff = [ox, oy];
      }
      // A shaped edge (torn / brush) implies feathering (the shape lives inside the feather band).
      const style = _edgeStyle(f);
      const fw = Math.max(0.001, Math.min(0.5, Number(f.featherWidth) || 0.12));
      this.uniforms.admFeatherOn = !!f.feather || style > 0;
      this.uniforms.admFeatherW = fw;
      this.uniforms.admEdgeStyle = style;
      if (style > 0) {
        const doc = this.tile?.document;
        const tw = Math.abs(Number(doc?.width) || 0) || 1;
        const th = Math.abs(Number(doc?.height) || 0) || 1;
        this.uniforms.admTileSize = [tw, th];
        this.uniforms.admWaveLen = Math.max(20, fw * (tw + th) / 2);
        // Per-tile seed from the document id: every tile gets its own contour, the same on all clients.
        if (!this._admSeed || this._admSeedId !== doc?.id) {
          let h = 2166136261;
          for (const ch of String(doc?.id ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
          h >>>= 0;
          this._admSeed = [(h % 1000) / 10, ((h >>> 10) % 1000) / 10];
          this._admSeedId = doc?.id;
        }
        this.uniforms.admWaveSeed = this._admSeed;
      }
    }
  }
  _ScrollShader = AdmTileScrollShader;
  return _ScrollShader;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply / reset on the tile object
// ─────────────────────────────────────────────────────────────────────────────
function _cfg(tileDoc) {
  return tileDoc?.flags?.[MODULE_ID]?.[FLAG] ?? {};
}

const _isPattern = (tileDoc) => { const f = _cfg(tileDoc); return !!f.enabled && !!f.world; };

/** Edge shape: 0 straight, 1 torn, 2 brush stroke. Tiles saved before the select had a «Wavy edge»
 *  checkbox (featherWavy) — that one is the torn shape. */
function _edgeStyle(f) {
  const s = f?.edgeStyle !== undefined ? f.edgeStyle : (f?.featherWavy ? "torn" : "");
  return s === "brush" ? 2 : (s === "torn" ? 1 : 0);
}

/** «Pattern»: the mesh (the window) always covers the whole tile. Core resize() multiplies the quad by
 *  the texture scale — here that scale sizes the pattern instead (read in _preRender), so the quad is
 *  re-fitted without it. Called after every core refresh (refreshTile hook) and on apply. */
function _fitPatternWindow(tileObj) {
  const mesh = tileObj?.mesh, doc = tileObj?.document;
  if (!mesh || !doc) return;
  try { mesh.resize(doc.width, doc.height, { fit: "fill" }); } catch (e) { console.warn("[ADM:tileScroll] fit:", e); }
}

function _applyToTile(tileObj) {
  const mesh = tileObj?.mesh;
  if (!mesh) return;
  const f = _cfg(tileObj.document);
  const on = !!f.enabled;

  // Window size: full tile in «Pattern» mode; otherwise hand sizing back to core once.
  if (on && f.world) {
    _fitPatternWindow(tileObj);
    tileObj._admPatternFit = true;
  } else if (tileObj._admPatternFit) {
    tileObj._admPatternFit = false;
    tileObj.renderFlags?.set({ refreshMesh: true });
  }

  // Scroll shader
  try {
    if (on) {
      mesh.setShaderClass(_scrollShaderClass());
      mesh.shader.tile = tileObj;
      mesh.texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
      mesh.texture.baseTexture.update();
    } else if (mesh.shader instanceof _scrollShaderClass()) {
      // Reset ONLY if OUR shader was set — leave default/foreign tiles alone. Restore
      // CLAMP (the baseTexture is shared between tiles of the same image — REPEAT would «leak»).
      mesh.setShaderClass(foundry.canvas.rendering.shaders.PrimaryBaseSamplerShader);
      mesh.texture.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
      mesh.texture.baseTexture.update();
    }
  } catch (e) { console.warn("[ADM:tileScroll] shader:", e); }

  // Feather is now INSIDE the mesh shader (see static get fragmentShader) — the exact local
  // coordinate gives a true zero alpha right at the edge. Here we only strip a possible
  // old PIXI filter (if one is left over from a previous session before reload).
  try {
    const flts = mesh.filters;
    if (Array.isArray(flts) && flts.some((flt) => flt?.admIsFeather)) {
      for (const flt of flts) if (flt?.admIsFeather) { try { flt.destroy(); } catch (_e) {} }
      const rest = flts.filter((flt) => !flt?.admIsFeather);
      mesh.filters = rest.length ? rest : null;
    }
  } catch (_e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// UI: spoiler in the tile config tab
// ─────────────────────────────────────────────────────────────────────────────
function _injectConfig(app, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  if (!root?.querySelector) return;
  if (root.querySelector('[name="flags.adm-levels.tileScroll.enabled"]')) return; // already injected

  const f = _cfg(app.document);
  const enabled = !!f.enabled;
  const world = !!f.world;
  const patternRotation = Number(f.patternRotation) || 0;
  const direction = Number(f.direction) || 0;
  const speed = Number(f.speed) || 5;
  const feather = !!f.feather;
  const edgeStyle = ["", "torn", "brush"][_edgeStyle(f)];
  const featherWidth = Number(f.featherWidth) || 0.12;

  const L = (k) => game.i18n.localize(`ADM_LEVELS.tileScroll.${k}`);
  const injectHtml = `
  <details class="adm-tilescroll" style="margin:6px 0;border:1px solid var(--color-border-light-tertiary,#7a7971);border-radius:4px;">
    <summary style="cursor:pointer;padding:4px 8px;font-weight:bold;list-style:revert;">${L("title")}</summary>
    <div style="padding:6px 8px 8px;">
      <div class="form-group slim">
        <label>${L("enabled")}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.adm-levels.tileScroll.enabled" ${enabled ? "checked" : ""}>
        </div>
      </div>
      <div class="form-group slim">
        <label data-tooltip="${L("worldHint")}">${L("world")}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.adm-levels.tileScroll.world" ${world ? "checked" : ""} data-tooltip="${L("worldHint")}">
        </div>
      </div>
      <div class="form-group slim" data-adm-tilescroll-rot style="${world ? "" : "display:none;"}">
        <label data-tooltip="${L("patternRotationHint")}">${L("patternRotation")}</label>
        <div class="form-fields">
          <range-picker name="flags.adm-levels.tileScroll.patternRotation" value="${patternRotation}" min="-180" max="180" step="1"></range-picker>
        </div>
      </div>
      <div class="form-group slim">
        <label>${L("direction")}</label>
        <div class="form-fields">
          <input type="number" step="any" name="flags.adm-levels.tileScroll.direction" value="${direction}" placeholder="0">
        </div>
      </div>
      <div class="form-group slim">
        <label data-adm-tilescroll-speed>${L(world ? "speedPx" : "speed")}</label>
        <div class="form-fields">
          <input type="number" step="any" name="flags.adm-levels.tileScroll.speed" value="${speed}" placeholder="5">
        </div>
      </div>
      <div class="form-group slim">
        <label>${L("feather")}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.adm-levels.tileScroll.feather" ${feather ? "checked" : ""}>
          <input type="number" step="0.01" min="0.01" max="0.5" name="flags.adm-levels.tileScroll.featherWidth" value="${featherWidth}" style="width:64px;" title="${L("featherWidthHint")}">
        </div>
      </div>
      <div class="form-group slim">
        <label data-tooltip="${L("edgeStyleHint")}">${L("edgeStyle")}</label>
        <div class="form-fields">
          <select name="flags.adm-levels.tileScroll.edgeStyle" data-tooltip="${L("edgeStyleHint")}">
            <option value="" ${edgeStyle === "" ? "selected" : ""}>${L("edgeStraight")}</option>
            <option value="torn" ${edgeStyle === "torn" ? "selected" : ""}>${L("edgeTorn")}</option>
            <option value="brush" ${edgeStyle === "brush" ? "selected" : ""}>${L("edgeBrush")}</option>
          </select>
        </div>
      </div>
    </div>
  </details>`;

  const anchor = root.querySelector('[name="texture.tint"]')?.closest(".form-group")
    ?? root.querySelector(".form-group");
  if (anchor) anchor.insertAdjacentHTML("afterend", injectHtml);
  else root.insertAdjacentHTML("beforeend", injectHtml);
  // «Pattern» switches the speed unit (tile fractions → pixels per second) — keep the label honest.
  const worldBox = root.querySelector('[name="flags.adm-levels.tileScroll.world"]');
  const speedLabel = root.querySelector("[data-adm-tilescroll-speed]");
  const rotRow = root.querySelector("[data-adm-tilescroll-rot]");   // pattern rotation works in «Pattern» only
  worldBox?.addEventListener("change", () => {
    if (speedLabel) speedLabel.textContent = L(worldBox.checked ? "speedPx" : "speed");
    if (rotRow) rotRow.style.display = worldBox.checked ? "" : "none";
    try { app.setPosition({ height: "auto" }); } catch (_e) {}
  });
  try { app.setPosition({ height: "auto" }); } catch (_e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ─────────────────────────────────────────────────────────────────────────────
export const TOOL = {
  id: "tileScroll",
  name: "ADM_LEVELS.settings.tileScroll.name",
  hint: "ADM_LEVELS.settings.tileScroll.hint",
  replaces: ["parallax-tiles", "tile-scroll"],

  onReady({ isEnabled }) {
    Hooks.on("renderTileConfig", (app, html) => {
      if (!isEnabled()) return;
      try { _injectConfig(app, html); } catch (e) { console.warn("[ADM:tileScroll] config:", e); }
    });

    // Apply when the tile is drawn and when its flags are updated.
    Hooks.on("drawTile", (tileObj) => {
      if (!isEnabled()) return;
      if (_cfg(tileObj?.document).enabled) _applyToTile(tileObj);
    });
    Hooks.on("updateTile", (tileDoc, changed) => {
      if (!isEnabled()) return;
      if (!foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.${FLAG}`)) return;
      const obj = tileDoc.object;
      if (obj) _applyToTile(obj);
    });
    // Core re-sizes the mesh with the texture scale on every size/mesh refresh (tile.mjs
    // _refreshSize/_refreshMesh); in «Pattern» mode put the window back to the whole tile right after.
    Hooks.on("refreshTile", (tileObj) => {
      if (!isEnabled()) return;
      if (_isPattern(tileObj?.document)) _fitPatternWindow(tileObj);
    });
  },
};
