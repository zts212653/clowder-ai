const plugin = require('tailwindcss/plugin');
const roles = require('../../src/components/chat-background/surface-roles.json');

// Accessibility roles do not decide the paint of a non-modal working drawer.
// A true nested dialog still establishes its own opaque boundary.
const opaque = [
  'select',
  'input:is([type="checkbox"], [type="radio"], [type="color"], [type="range"])',
  '[data-chat-background-layer="opaque"]',
  'dialog:not([data-chat-background-layer="work"])',
  '[role="dialog"]:not([data-chat-background-layer="work"])',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[data-thread-settings-panel]',
  '[class~="work-gallery-menu"]',
  '[class~="cafe-tooltip"]',
  '[class~="you-settings-save"]',
  '[class~="cafe-toggle"]',
  '[role="switch"]',
  '[class~="bg-cafe-accent"]',
  ':is(button, a, span, label, [role="button"])[class*="bg-cafe-accent"]',
  '[class*="bg-semantic-"]',
  '[class~="work-gallery-latest"]',
].join(', ');
const active = ':is(html[data-shell="v2"][data-chat-background="image"] *)';
const boundary = `:not(:is(${opaque}), :is(${opaque}) *)`;

function imagePaint(role) {
  return {
    '--chat-background-surface': role.colour,
    ...(!role.hoverBases ? { '--chat-background-hover-base': role.colour } : {}),
    'background-color': `${role.colour} !important`,
    'background-image': [
      'linear-gradient(',
      'color-mix(in srgb, var(--chat-background-surface) calc(var(--chat-background-veil-opacity) * 100%), transparent),',
      'color-mix(in srgb, var(--chat-background-surface) calc(var(--chat-background-veil-opacity) * 100%), transparent)',
      '), var(--chat-background-image) !important',
    ].join(''),
    'background-position': 'center, center !important',
    'background-size': 'auto, var(--chat-background-size) !important',
    'background-repeat': 'no-repeat, var(--chat-background-repeat) !important',
    'background-attachment': 'scroll, fixed !important',
  };
}

/** Existing neutral utilities and explicit surfaces share one compositor and one palette registry. */
module.exports = plugin(({ addBase, addUtilities, e }) => {
  // Animated working layers can cache descendants' fixed artwork at local coordinates.
  // Keep these persistent layers stable while an image is active; child status animations remain native.
  const attributes = {
    [`[data-chat-background-layer="work"]${active}${boundary}`]: { animation: 'none !important' },
  };
  const utilities = {};
  for (const [name, role] of Object.entries(roles)) {
    const modes = role.modes ? `:is(${role.modes.map((mode) => `html[data-theme="${mode}"] *`).join(', ')})` : '';
    const condition = `${active}${modes}`;
    attributes[`[data-chat-background-surface="${name}"]${condition}${boundary}`] = imagePaint(role);
    utilities[`.${e(`cafe-surface-${name}`)}`] = {
      // @apply decorates the consumer's existing paint; no-image/classic keeps it byte-for-byte.
      [`&${condition}:not([data-chat-background-surface])${boundary}`]: imagePaint(role),
    };
    for (const alias of role.aliases ?? []) {
      utilities[`.${e(alias)}`] = {
        // A consumer's explicit role wins over its reusable component's default utility.
        [`&${condition}:not([data-chat-background-surface], [class*="cafe-surface-"])${boundary}`]: imagePaint(role),
      };
    }
  }
  addBase(attributes);
  // Tailwind applies the same ownership rules to hover, focus, dark and responsive variants.
  addUtilities(utilities);
});
