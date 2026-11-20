/** F336 Phase C: the panel's pending-decision badge stays clickable while the living cat is the body.
 * In living mode the panel window passes every click through except an open panel, and the badge the
 * panel still draws on its (invisible) pet anchor would be unreachable. The Host takes no rect from the
 * page: it mirrors where the shipped renderer draws the badge and when it shows it, from the layout it
 * placed itself and the replies it routed, and lets only that small rect take clicks.
 * Mirrors @clowder-ai/companion 0.1.0-alpha.38 (like pet-placement.cjs mirrors living-geometry.mjs):
 * - decision-view.mjs decisionBadge().visible and its label; decision-panel.mjs hides the badge unless
 *   proactivePolicy is quiet-badge, and shows `?` after a failed read;
 * - style.css: #anchor is 120×130 × ballSize/72 at the layout's pet point; #pending-badge sits at its top
 *   right, 24 px tall, border-box min-width 24 px plus 7 px padding and a 2 px border each side. */
const HEIGHT = 24;
const MIN_WIDTH = 24;
const MAX_WIDTH = 56;
const ANCHOR_WIDTH = 120;
const ANCHOR_HEIGHT = 130;
const SHARE_SIZE = 32;

const unified = (page) => page?.version === 1 && Array.isArray(page.items);
const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/** decisionBadge(page) of the renderer: undefined is a failed read. Returns the label, or null when hidden. */
function badgeLabel(page) {
  if (!page) return '?';
  return unified(page) ? unifiedLabel(page) : legacyLabel(page);
}
function unifiedLabel(page) {
  if (page.status === 'partial') return page.items.length > 0 ? '•' : '!';
  if (page.status === 'unavailable') return '!';
  if (Number.isInteger(page.totalCount)) return page.totalCount === 0 ? null : String(page.totalCount);
  return page.items.length > 0 ? '•' : '!';
}
function legacyLabel(page) {
  if (page.status !== 'available') return '?';
  const rows = (page.approvals?.length ?? 0) + (page.otherNeedsMe?.length ?? 0);
  const counts = count(page.approvalCount) + count(page.needsMeCount) + count(page.otherNeedsMeCount);
  return rows + counts > 0 ? '有待办' : null;
}

/** 11 px bold text: about 11 px per CJK character, 7 px otherwise. */
function badgeWidth(label) {
  const text = [...label].reduce((sum, char) => sum + (/[\u3000-\u9fff]/.test(char) ? 11 : 7), 0);
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, text + 18));
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** The page swaps its indicators to the anchor's left side when the anchor sits within 40 px of the work
 * area's right edge (living-edge.mjs detectDockedEdge; style.css `#pet[data-dock-edge="right"] + #indicators`). */
function dockedRight(layout, ballSize, area) {
  if (!area) return false;
  return area.x + area.width - (layout.pet.x + (ANCHOR_WIDTH * ballSize) / 72) <= 40;
}

/** The stop-sharing badge (#share-badge): 32 x 32 at the anchor box's bottom right, bottom left when docked right,
 * shown while a screen is shared or picked (surface.mjs). `shown` comes from the Host controller's own screen state. */
function shareBadgeRect(layout, ballSize, area, shown) {
  if (!shown || !layout?.pet || !layout.bounds) return null;
  const width = (ANCHOR_WIDTH * ballSize) / 72;
  const bottom = layout.pet.y + (ANCHOR_HEIGHT * ballSize) / 72;
  const x = dockedRight(layout, ballSize, area) ? layout.pet.x : layout.pet.x + width - SHARE_SIZE;
  return intersect({ x, y: bottom - SHARE_SIZE, width: SHARE_SIZE, height: SHARE_SIZE }, layout.bounds);
}

/** shareShown: the Host controller's own screen state (a screen is shared or a pick is pending). */
function createPendingBadge({ shareShown } = {}) {
  let read = false; // no decisions reply yet: the shipped page keeps the badge hidden
  let label = null;
  let policy;
  return {
    /** Every trusted reply the panel route hands back to the panel page. */
    observe(command, reply) {
      if (command?.kind === 'decisions.read') {
        read = true;
        label = badgeLabel(reply?.kind === 'decisions' ? reply : undefined);
      } else if (reply?.kind === 'settings' && reply.status === 'available') policy = reply.values?.proactivePolicy;
    },
    /** The badge's screen rect inside the panel window, or null while the page does not show it. */
    rect(layout, ballSize, area) {
      if (!read || label === null || policy !== 'quiet-badge' || !layout?.pet || !layout.bounds) return null;
      const right = layout.pet.x + (ANCHOR_WIDTH * ballSize) / 72;
      const width = badgeWidth(label);
      const x = dockedRight(layout, ballSize, area) ? layout.pet.x : right - width;
      return intersect({ x, y: layout.pet.y, width, height: HEIGHT }, layout.bounds);
    },
    /** The stop-sharing badge's screen rect, or null while the page does not show it. */
    shareRect(layout, ballSize, area) {
      return shareBadgeRect(layout, ballSize, area, shareShown?.() === true);
    },
  };
}

module.exports = { createPendingBadge, badgeLabel, shareBadgeRect };
