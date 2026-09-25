// modules/adm-levels/scripts/tools/door-quick.mjs
// ADMaps Tools — «Quick door».
//
// A button right after «Door Type» in the wall config: one click makes the wall the owner's usual
// wooden door — the one on his maps (Modular_Ship_Pack, 23.09.2026): door sound «woodBasic», swing
// animation of 750 ms at strength 1, the small door texture Door_Metal_Rusty_F (a brown plank),
// single leaf, not flipped, every restriction normal. The door starts closed; a wall that already
// was a door keeps its state.
//
// The form's pending edits are saved together with the door (the whole form goes into the update,
// as on «Save»): the window re-renders after the update and would drop them otherwise — the same
// way as «Invert door» (door-invert.mjs). All the edited walls get it; the Mass Edit form (it fires
// renderWallConfig too and saves its own way, `app.meForm`) gets no button.

const QUICK_DOOR = {
  door: 1,                     // CONST.WALL_DOOR_TYPES.DOOR
  doorSound: "woodBasic",
  animation: {
    type: "swing",
    texture: "canvas/doors/small/Door_Metal_Rusty_F_1x1.webp",
    direction: 1,
    double: false,
    duration: 750,
    strength: 1,
    flip: false,
  },
};

const _t = (key, data) => (data
  ? game.i18n.format(`ADM_LEVELS.doorQuick.${key}`, data)
  : game.i18n.localize(`ADM_LEVELS.doorQuick.${key}`));

async function _makeDoor(app) {
  const form = app.form;
  if (!form) return;
  const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
  // The same data «Save» would send — validated by the sheet itself.
  const data = app._prepareSubmitData(null, form, new FDE(form));
  const scene = app.document?.parent;
  if (!scene) return;
  const S = CONST.WALL_SENSE_TYPES;
  const updates = [];
  for (const wall of app.editTargets ?? [app.document]) {
    if (!scene.walls.has(wall.id)) continue;
    updates.push({
      _id: wall.id,
      ...foundry.utils.deepClone(data),
      ...foundry.utils.deepClone(QUICK_DOOR),
      move: S.NORMAL, sight: S.NORMAL, light: S.NORMAL, sound: S.NORMAL,
      ds: Number(wall.door) > 0 ? wall.ds : CONST.WALL_DOOR_STATES.CLOSED,
    });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Wall", updates);
}

function _attach(app, element) {
  if (app?.meForm) return;                                         // Mass Edit form — see the header
  const el = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
  const form = app?.form;
  if (!el || !form || el.querySelector("[data-adm-door-quick]")) return;
  const typeGroup = form.querySelector('[name="door"]')?.closest(".form-group");
  if (!typeGroup) return;

  const group = document.createElement("div");
  group.className = "form-group";
  group.dataset.admDoorQuick = "1";
  group.innerHTML = `
    <label></label>
    <div class="form-fields">
      <button type="button" data-adm-door-quick-btn>
        <i class="fa-solid fa-door-open"></i> ${_t("button")}
      </button>
    </div>
    <p class="hint">${_t("hint")}</p>`;
  typeGroup.after(group);

  const btn = group.querySelector("[data-adm-door-quick-btn]");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await _makeDoor(app); }
    catch (e) {
      console.error("[ADM:LEVELS] quick door failed", e);
      ui.notifications.error(_t("failed", { error: e?.message ?? e }));
      btn.disabled = false;
    }
  });
  app.setPosition?.();                                             // the form got taller
}

export const TOOL = {
  id: "doorQuick",
  name: "ADM_LEVELS.settings.doorQuick.name",
  hint: "ADM_LEVELS.settings.doorQuick.hint",

  onReady({ isEnabled }) {
    Hooks.on("renderWallConfig", (app, element) => {
      if (!isEnabled() || !game.user?.isGM) return;
      try { _attach(app, element); } catch (e) { console.warn("[ADM:LEVELS] quick door: attach failed", e); }
    });
  },
};
