// scripts/tools/token-sort.mjs
// ADMaps Tools sub-module: automatic token z-order (formerly the standalone admaps-token-sort module).
// Small tokens are drawn above large ones (by footprint area); the active combatant / last
// moved token goes on top of its own size tier. Writes the core Token.sort field (GM-only).

let _lastActiveTokenId = null;
let _recalcTimer = null;
let _isEnabled = () => true;

function _calcSort(td, activeTokenId) {
  const w = td.width || 1, h = td.height || 1;
  const size = w * h;
  // Size tiers: 1×1=6, 2×2=4, 3×3=2, 4×4+=1. Active / last moved token: +1 within its tier.
  const sizeSort = size <= 1 ? 6 : size <= 4 ? 4 : size <= 9 ? 2 : 1;
  return sizeSort + (td.id === activeTokenId ? 1 : 0);
}

async function _recalcAll(activeTokenId = null) {
  if (!_isEnabled()) return;          // checkbox (live)
  if (!game.user?.isGM) return;       // only the GM writes (avoids conflicts)
  const scene = canvas?.scene;
  if (!scene?.tokens?.size) return;
  const updates = [];
  for (const td of scene.tokens) {
    const newSort = _calcSort(td, activeTokenId);
    if (td.sort !== newSort) updates.push({ _id: td.id, sort: newSort });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { _admTokenSort: true });
}

function _debouncedRecalc(activeTokenId) {
  if (_recalcTimer) clearTimeout(_recalcTimer);
  _recalcTimer = setTimeout(() => { _recalcTimer = null; _recalcAll(activeTokenId); }, 50);
}

export const TOOL = {
  id: "tokenSort",
  name: "ADM_LEVELS.settings.tokenSort.name",
  hint: "ADM_LEVELS.settings.tokenSort.hint",
  replaces: ["admaps-token-sort"],

  onReady({ isEnabled }) {
    _isEnabled = isEnabled;
    // Turn change: raise the active combatant.
    Hooks.on("updateCombat", (combat, change) => {
      if (!("turn" in change || "round" in change)) return;
      const tokenId = combat?.combatant?.tokenId;
      if (tokenId) { _lastActiveTokenId = tokenId; _debouncedRecalc(tokenId); }
    });
    // Token moved: raise it within its tier.
    Hooks.on("moveToken", (doc) => { _lastActiveTokenId = doc?.id || null; _debouncedRecalc(doc?.id); });
    // New token: recalculate.
    Hooks.on("createToken", () => _debouncedRecalc(_lastActiveTokenId));
    // Size change: recalculate (our own sort updates are skipped via options._admTokenSort).
    Hooks.on("updateToken", (doc, change, options) => {
      if (options?._admTokenSort) return;
      if ("width" in change || "height" in change) _debouncedRecalc(_lastActiveTokenId);
    });
    // Canvas ready: initial sort.
    Hooks.on("canvasReady", () => {
      const activeId = game.combat?.started ? game.combat.combatant?.tokenId : null;
      _lastActiveTokenId = activeId || null;
      setTimeout(() => _recalcAll(activeId), 300);
    });
  },
};
