// ADMaps_PropsAutoPos
// Auto-positioning of a tile on the scene via pixel matching.
// The button is added to the Tile HUD (opened by right-clicking the tile).

const MODULE_ID = "ADMaps_PropsAutoPos"; // kept: the i18n prefix + data-action + CSS selector depend on it
let _isEnabled = () => true;             // sub-module toggle (set in onReady)

const t  = (key, args) => game.i18n.format(`${MODULE_ID}.${key}`, args ?? {});
const tL = (key)        => game.i18n.localize(`${MODULE_ID}.${key}`);

/* ========================================================================
 *  Tile HUD button injection
 * ======================================================================== */

function _onRenderTileHUD(hud, html) {
  if (!_isEnabled()) return;   // sub-module toggle (live)
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
  if (!root) return;
  if (root.querySelector(`[data-action="${MODULE_ID}-align"]`)) return;

  const btn = document.createElement("div");
  btn.classList.add("control-icon");
  btn.dataset.action = `${MODULE_ID}-align`;
  btn.title = tL("Tooltip");
  btn.setAttribute("data-tooltip", tL("Tooltip"));
  btn.innerHTML = `<i class="fa-solid fa-crosshairs"></i>`;

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.classList.contains("is-running")) return;
    btn.classList.add("is-running");
    try { await runAlignment(hud.object); }
    catch (e) { console.error("[ADMaps_PropsAutoPos] error", e); ui.notifications.error(String(e?.message ?? e)); }
    finally { btn.classList.remove("is-running"); }
  });

  // Where to insert — try the right column, then the left, then the root.
  const target = root.querySelector(".col.right")
              || root.querySelector(".col.left")
              || root.querySelector(".col")
              || root;
  target.appendChild(btn);
}

/* ========================================================================
 *  Image loading (image OR video)
 * ======================================================================== */

const VIDEO_EXT = /\.(webm|mp4|mov|m4v|ogv)(\?|$)/i;

async function loadImageData(src) {
  const isVideo = VIDEO_EXT.test(src);
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d", { willReadFrequently: true });

  if (isVideo) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error(t("VideoFail", { src })));
      setTimeout(() => rej(new Error(t("VideoTimeout", { src }))), 15000);
    });
    try { video.currentTime = 0; } catch (_) {}
    await new Promise(res => {
      if (video.readyState >= 2) res();
      else video.onseeked = res;
    });
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
  } else {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error(t("ImageFail", { src })));
      img.src = src;
    });
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
  }
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

/* ========================================================================
 *  Image processing
 * ======================================================================== */

/** Rescale ImageData to arbitrary targetW × targetH via canvas
 *  (uses built-in hardware smoothing). Needed when the tile source has
 *  a different size than `tile.document.width/height` on the canvas. */
function scaleImageData(im, targetW, targetH) {
  if (im.width === targetW && im.height === targetH) return im;
  const src = document.createElement("canvas");
  src.width = im.width; src.height = im.height;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  // ImageData may be our own { data, width, height } from downsample — normalize:
  const idata = (im instanceof ImageData) ? im : new ImageData(im.data, im.width, im.height);
  sctx.putImageData(idata, 0, 0);

  const dst = document.createElement("canvas");
  dst.width = targetW; dst.height = targetH;
  const dctx = dst.getContext("2d", { willReadFrequently: true });
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(src, 0, 0, targetW, targetH);
  return dctx.getImageData(0, 0, targetW, targetH);
}

/** Downscale by a factor of N (block average). */
function downsample(im, factor) {
  if (factor === 1) return im;
  const w = Math.floor(im.width / factor);
  const h = Math.floor(im.height / factor);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= im.width || sy >= im.height) continue;
          const i = (sy * im.width + sx) * 4;
          r += im.data[i]; g += im.data[i + 1]; b += im.data[i + 2]; a += im.data[i + 3];
          n++;
        }
      }
      const oi = (y * w + x) * 4;
      out[oi] = r / n; out[oi + 1] = g / n; out[oi + 2] = b / n; out[oi + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** Mask: only pixels with a high local gradient.
 *  Flat areas (silhouette, uniform color) are ignored. */
function buildGradientMask(im, gradThreshold = 40, alphaThreshold = 128) {
  const { data, width: w, height: h } = im;
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < alphaThreshold) continue;
      const li = (y * w + x - 1) * 4;
      const ri = (y * w + x + 1) * 4;
      const ui = ((y - 1) * w + x) * 4;
      const di = ((y + 1) * w + x) * 4;
      const gx = Math.abs(data[li]     - data[ri])     +
                 Math.abs(data[li + 1] - data[ri + 1]) +
                 Math.abs(data[li + 2] - data[ri + 2]);
      const gy = Math.abs(data[ui]     - data[di])     +
                 Math.abs(data[ui + 1] - data[di + 1]) +
                 Math.abs(data[ui + 2] - data[di + 2]);
      if (gx + gy >= gradThreshold) { mask[y * w + x] = 1; count++; }
    }
  }
  return { mask, count };
}

/** SAD with capping (Huber loss) over the pixel mask. */
function matchByMask(scene, tile, tileMask, x0, y0, x1, y1) {
  let bestX = 0, bestY = 0, bestScore = Infinity;
  const sw = scene.width, sh = scene.height;
  const tw = tile.width, th = tile.height;
  const PIXEL_CAP = 100;

  const xMin = Math.max(0, x0);
  const yMin = Math.max(0, y0);
  const xMax = Math.min(sw - tw, x1);
  const yMax = Math.min(sh - th, y1);

  // Collect the indices of the tile's interesting pixels once (with coordinates).
  const idxList = [];
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      if (tileMask.mask[ty * tw + tx]) idxList.push([(ty * tw + tx) * 4, tx, ty]);
    }
  }

  for (let sy = yMin; sy <= yMax; sy++) {
    for (let sx = xMin; sx <= xMax; sx++) {
      let score = 0;
      let stop = false;
      for (let k = 0; k < idxList.length; k++) {
        const [ti, tx, ty] = idxList[k];
        const si = ((sy + ty) * sw + (sx + tx)) * 4;
        let dr = tile.data[ti]     - scene.data[si];     if (dr < 0) dr = -dr;
        let dg = tile.data[ti + 1] - scene.data[si + 1]; if (dg < 0) dg = -dg;
        let db = tile.data[ti + 2] - scene.data[si + 2]; if (db < 0) db = -db;
        if (dr > PIXEL_CAP) dr = PIXEL_CAP;
        if (dg > PIXEL_CAP) dg = PIXEL_CAP;
        if (db > PIXEL_CAP) db = PIXEL_CAP;
        score += dr + dg + db;
        if (score >= bestScore) { stop = true; break; }
      }
      if (!stop && score < bestScore) {
        bestScore = score;
        bestX = sx;
        bestY = sy;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore, count: idxList.length };
}

/* ========================================================================
 *  Main alignment
 * ======================================================================== */

async function runAlignment(tile) {
  if (!game.user?.isGM) return ui.notifications.warn(tL("NotGM"));
  if (!tile?.document) return;

  const tileSrc = tile.document.texture?.src;
  const sceneSrc = canvas.scene?.background?.src ?? canvas.scene?.img;
  if (!sceneSrc) return ui.notifications.error(tL("NoBackground"));
  if (!tileSrc)  return ui.notifications.error(tL("NoBackground"));

  const t0 = performance.now();

  ui.notifications.info(tL("Loading"));
  let sceneData, tileData;
  try {
    [sceneData, tileData] = await Promise.all([
      loadImageData(sceneSrc),
      loadImageData(tileSrc),
    ]);
  } catch (e) { return ui.notifications.error(e.message); }

  console.log(`[${MODULE_ID}] scene ${sceneData.width}×${sceneData.height} | tile ${tileData.width}×${tileData.height}`);

  // Normalization: tile coordinates on the scene (`tile.document.x/y/width/height`)
  // are in scene pixels (without padding). So that matching happens in the same coordinate
  // system, both images are brought to the scene pixel density.
  // 1) Scene — to (sceneWidth × sceneHeight) from dimensions.
  const sceneW = Math.round(Number(canvas.scene?.dimensions?.sceneWidth)  || canvas.scene?.width  || 0);
  const sceneH = Math.round(Number(canvas.scene?.dimensions?.sceneHeight) || canvas.scene?.height || 0);
  if (sceneW > 0 && sceneH > 0 && (sceneData.width !== sceneW || sceneData.height !== sceneH)) {
    console.log(`[${MODULE_ID}] auto-scale scene ${sceneData.width}×${sceneData.height} → ${sceneW}×${sceneH}`);
    sceneData = scaleImageData(sceneData, sceneW, sceneH);
  }
  // 2) Tile — to its canvas size.
  const docW = Math.round(Number(tile.document.width)  || 0);
  const docH = Math.round(Number(tile.document.height) || 0);
  if (docW > 0 && docH > 0 && (tileData.width !== docW || tileData.height !== docH)) {
    console.log(`[${MODULE_ID}] auto-scale tile ${tileData.width}×${tileData.height} → ${docW}×${docH}`);
    tileData = scaleImageData(tileData, docW, docH);
  }

  // Coarse-to-fine.
  const COARSE = 4;
  const sceneC = downsample(sceneData, COARSE);
  const tileC  = downsample(tileData,  COARSE);

  const tileCMask = buildGradientMask(tileC, 30);
  const tileFMask = buildGradientMask(tileData, 40);
  console.log(`[${MODULE_ID}] mask coarse: ${tileCMask.count} | fine: ${tileFMask.count}`);

  if (tileFMask.count < 200) {
    return ui.notifications.error(t("TooFlat", { count: tileFMask.count }));
  }

  ui.notifications.info(t("CoarseSearch", { factor: COARSE, count: tileCMask.count }));
  const coarse = matchByMask(sceneC, tileC, tileCMask, 0, 0, sceneC.width, sceneC.height);

  ui.notifications.info(t("FineSearch", { count: tileFMask.count }));
  const cx = coarse.x * COARSE, cy = coarse.y * COARSE, R = COARSE + 2;
  const fine = matchByMask(sceneData, tileData, tileFMask, cx - R, cy - R, cx + R, cy + R);

  const dt = Math.round(performance.now() - t0);
  console.log(`[${MODULE_ID}] coarse`, coarse, "| fine", fine, `| time ${dt}ms`);

  // Account for the scene offset (padding).
  const sceneOffX = canvas.dimensions?.sceneX ?? 0;
  const sceneOffY = canvas.dimensions?.sceneY ?? 0;
  const finalX = fine.x + sceneOffX;
  const finalY = fine.y + sceneOffY;

  await tile.document.update({ x: finalX, y: finalY });

  const avgErr = fine.count > 0 ? (fine.score / fine.count / 3) : 0;
  ui.notifications.info(t("Placed", {
    x: finalX, y: finalY,
    err: avgErr.toFixed(1),
    count: fine.count,
    time: dt,
  }));
}

export const TOOL = {
  id: "propsAutoPos",
  name: "ADM_LEVELS.settings.propsAutoPos.name",
  hint: "ADM_LEVELS.settings.propsAutoPos.hint",
  replaces: ["ADMaps_PropsAutoPos"],
  onReady({ isEnabled }) {
    _isEnabled = isEnabled;
    Hooks.on("renderTileHUD", _onRenderTileHUD);
  },
};
