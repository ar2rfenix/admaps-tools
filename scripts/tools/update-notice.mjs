// scripts/tools/update-notice.mjs
// ADMaps Tools sub-module: «Update notice».
//
// When a newer ADMaps Tools release is out, the GM gets a window on load: the installed and the new version, how to
// update and a link to the release notes (25.09.2026: «on every update show people a window, so they know they need
// to update; a "Don't show again" checkbox at the bottom»). The checkbox hides the window for THAT version only — the
// next release shows it again. It is saved the moment it is ticked, so closing the window with the cross keeps it.
//
// The latest version is read from the GitHub API (api.github.com/repos/<owner>/<repo>/releases/latest), not from the
// manifest URL: a release download on github.com answers with a redirect that carries no CORS header, and the browser
// refuses to read it; the API sends Access-Control-Allow-Origin: *. The repository comes from the manifest's "url".
// No network, the API rate limit, no release yet — silently nothing.

const MODULE_ID = "adm-levels";
const SKIP = "updateNoticeSkip";               // user setting: the version the user asked not to be told about again
const REPO_FALLBACK = "ar2rfenix/admaps-tools";
const TIMEOUT_MS = 10000;

/** "owner/repo" from the manifest's "url" (https://github.com/owner/repo). */
function _repo() {
  const m = String(game.modules.get(MODULE_ID)?.url ?? "").match(/github\.com\/([^/]+\/[^/#?]+)/i);
  return (m?.[1] ?? REPO_FALLBACK).replace(/\.git$/i, "");
}

/** { version, url } of the latest GitHub release, or null. */
async function _latestRelease() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${_repo()}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" }, cache: "no-store", signal: ctl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const version = String(data?.tag_name ?? "").trim().replace(/^v/i, "");
    return version ? { version, url: String(data?.html_url ?? "") } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _check() {
  const current = String(game.modules.get(MODULE_ID)?.version ?? "");
  const latest = await _latestRelease();
  if (!current || !latest || !foundry.utils.isNewerVersion(latest.version, current)) return;
  if (game.settings.get(MODULE_ID, SKIP) === latest.version) return;

  const esc = foundry.utils.escapeHTML;
  const t = (k, data) => (data ? game.i18n.format(`ADM_LEVELS.updateNotice.${k}`, data) : game.i18n.localize(`ADM_LEVELS.updateNotice.${k}`));
  const notes = /^https:\/\/github\.com\//i.test(latest.url)
    ? `<p><a href="${esc(latest.url)}" target="_blank" rel="noopener">${esc(t("notes"))}</a></p>` : "";
  const content = `<p>${esc(t("body", { latest: latest.version, current }))}</p>
    <p>${esc(t("how"))}</p>
    ${notes}
    <div class="form-group" style="margin-top:.8em;">
      <label class="checkbox" style="display:flex;align-items:center;gap:.4em;">
        <input type="checkbox" name="skip"> ${esc(t("skip"))}
      </label>
    </div>`;

  await foundry.applications.api.DialogV2.wait({
    window: { title: t("title"), icon: "fa-solid fa-circle-up" },
    position: { width: 420 },
    content,
    buttons: [{ action: "ok", label: t("ok"), icon: "fa-solid fa-check", default: true }],
    rejectClose: false,
    render: (_event, dialog) => {
      const box = dialog.element?.querySelector?.('input[name="skip"]');
      box?.addEventListener("change", () => {
        game.settings.set(MODULE_ID, SKIP, box.checked ? latest.version : "").catch(() => {});
      });
    },
  }).catch(() => null);
}

export const TOOL = {
  id: "updateNotice",
  name: "ADM_LEVELS.settings.updateNotice.name",
  hint: "ADM_LEVELS.settings.updateNotice.hint",

  onInit() {
    game.settings.register(MODULE_ID, SKIP, { scope: "user", config: false, type: String, default: "" });
  },

  onReady({ isEnabled }) {
    // Tools start on "setup"; the window waits for the game to be ready. Only a GM can update modules.
    Hooks.once("ready", () => {
      if (!isEnabled() || !game.user?.isGM) return;
      _check().catch(() => {});
    });
  },
};
