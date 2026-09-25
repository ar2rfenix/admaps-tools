// modules/adm-levels/scripts/tools/door-invert.mjs
// ADMaps Tools — «Invert door».
//
// A button right after «Open Direction» in the wall config's door animation section. It swaps
// the wall's end points, so the door opens from the other end: a door drawn left to right
// hinges on the left point, and the owner needed it on the right one (23.09.2026).
//
// What changes along with the points, so that only the hinge moves:
//  • dir (restriction direction) LEFT ⇄ RIGHT — a wall's sides are named relative to A→B;
//  • swing: animation.direction ×−1 and animation.flip toggled — exactly what the core does for
//    the right leaf of a double door (canvas/containers/elements/door-mesh.mjs, DOUBLE_RIGHT:
//    hinge at B, direction ×−1, texture scaleY ×−1). The door still opens into the same side
//    and its texture shows the same face;
//  • slide: the points only — the door then retracts towards the other end, which is the point.
// A mid-point pivot (swivel, ascend, descend) and a double door (hinges at both ends) have
// nothing to swap — the button is disabled there and the hint below it says why.
//
// The form's pending edits are saved together with the swap (the whole form goes into the
// update, as on «Save»): the window re-renders after the update and would drop them otherwise.
// Mass Edit builds its form on top of WallConfig (it fires renderWallConfig too) and saves its own
// way — the button is not added there.

const _t = (key, data) => (data
  ? game.i18n.format(`ADM_LEVELS.doorInvert.${key}`, data)
  : game.i18n.localize(`ADM_LEVELS.doorInvert.${key}`));

/** Why the button cannot work for the form's current values; "" — it can. */
function _whyNot(form) {
  if (form?.["animation.double"]?.checked) return _t("double");
  const type = form?.["animation.type"]?.value ?? "";
  if (CONFIG.Wall.animationTypes?.[type]?.midpoint) return _t("midpoint");
  return "";
}

async function _invert(app) {
  const form = app.form;
  if (!form || _whyNot(form)) return;
  const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
  // The same data «Save» would send — validated by the sheet itself.
  const data = app._prepareSubmitData(null, form, new FDE(form));
  const scene = app.document?.parent;
  if (!scene) return;
  const swing = data.animation?.type === "swing";
  const { LEFT, RIGHT } = CONST.WALL_DIRECTIONS;
  const updates = [];
  for (const wall of app.editTargets ?? [app.document]) {
    if (!scene.walls.has(wall.id)) continue;
    const [x0, y0, x1, y1] = wall.c;
    const u = { _id: wall.id, ...foundry.utils.deepClone(data), c: [x1, y1, x0, y0] };
    const dir = Number(u.dir ?? wall.dir);
    if (dir === LEFT) u.dir = RIGHT;
    else if (dir === RIGHT) u.dir = LEFT;
    if (swing && u.animation) {
      u.animation.direction = -(Number(u.animation.direction) || 1);
      u.animation.flip = !u.animation.flip;
    }
    updates.push(u);
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Wall", updates);
}

function _attach(app, element) {
  if (app?.meForm) return;                                         // Mass Edit form — see the header
  const el = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
  const form = app?.form;
  if (!el || !form || el.querySelector("[data-adm-door-invert]")) return;
  const dirGroup = form.querySelector('[name="animation.direction"]')?.closest(".form-group");
  if (!dirGroup) return;

  const group = document.createElement("div");
  group.className = "form-group";
  group.dataset.admDoorInvert = "1";
  group.innerHTML = `
    <label>${_t("label")}</label>
    <div class="form-fields">
      <button type="button" data-adm-door-invert-btn>
        <i class="fa-solid fa-right-left"></i> ${_t("button")}
      </button>
    </div>
    <p class="hint" data-adm-door-invert-hint></p>`;
  dirGroup.after(group);

  const btn = group.querySelector("[data-adm-door-invert-btn]");
  const hint = group.querySelector("[data-adm-door-invert-hint]");
  const paint = () => {
    const why = _whyNot(form);
    btn.disabled = !!why;
    hint.textContent = why || _t("hint");
  };
  paint();
  // «Double Door» and the animation type are switched in place, without a re-render. The
  // listener goes on the body part: it is replaced on every render together with the button,
  // while the <form> itself survives renders and would pile up listeners.
  (dirGroup.closest(".standard-form") ?? form).addEventListener("change", (ev) => {
    if (ev.target?.name === "animation.double" || ev.target?.name === "animation.type") paint();
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await _invert(app); }
    catch (e) {
      console.error("[ADM:LEVELS] door invert failed", e);
      ui.notifications.error(_t("failed", { error: e?.message ?? e }));
      paint();
    }
  });
  app.setPosition?.();                                             // the form got taller
}

export const TOOL = {
  id: "doorInvert",
  name: "ADM_LEVELS.settings.doorInvert.name",
  hint: "ADM_LEVELS.settings.doorInvert.hint",

  onReady({ isEnabled }) {
    Hooks.on("renderWallConfig", (app, element) => {
      if (!isEnabled() || !game.user?.isGM) return;
      try { _attach(app, element); } catch (e) { console.warn("[ADM:LEVELS] door invert: attach failed", e); }
    });
  },
};
