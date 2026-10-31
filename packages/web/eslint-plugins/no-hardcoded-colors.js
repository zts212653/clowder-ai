/**
 * ESLint rule: cafe/no-hardcoded-colors
 *
 * Prevents new hardcoded color values in TSX/TS files.
 * Part of F056 Phase A-0 governance gate.
 *
 * Catches:
 *   1. Hex color literals in string literals/template literals used in className or style
 *   2. Non-semantic Tailwind color classes (bg-white, text-gray-700, bg-red-500, etc.)
 *   3. Arbitrary Tailwind color values (bg-[#xxx], text-[#xxx])
 *
 * Allows:
 *   - Semantic cat tokens: bg-opus-primary, text-codex-dark, etc.
 *   - Cafe tokens: bg-cafe-white, text-cafe-black
 *   - Werewolf tokens: bg-ww-base, text-ww-main, etc.
 *   - CSS variable references: var(--)
 *   - Colors in comments
 *   - Non-UI contexts (data objects, constants defining token values)
 */

// Tailwind color families that should use semantic tokens instead
const RAW_COLOR_FAMILIES = [
  'white',
  'black',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

const TW_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'from',
  'to',
  'via',
  'outline',
  'shadow',
  'accent',
  'decoration',
  'fill',
  'stroke',
];

// Build regex for raw Tailwind color classes
const rawColorPattern = new RegExp(
  `\\b(?:${TW_PREFIXES.join('|')})-(?:${RAW_COLOR_FAMILIES.join('|')})(?:-\\d{2,3})?(?:\\/\\d+)?\\b`,
);

// Arbitrary color values: bg-[#xxx], text-[#xxx]
const arbitraryColorPattern =
  /\b(?:bg|text|border|ring|divide|from|to|via|outline|shadow|accent|decoration|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/;

// F056 Phase E AC-E11: arbitrary oklch() values in className: bg-[oklch(...)] / text-[oklch(...)]
const arbitraryOklchPattern =
  /\b(?:bg|text|border|ring|divide|from|to|via|outline|shadow|accent|decoration|fill|stroke)-\[oklch\(/;

// 砚砚 round-5 P2: arbitrary values containing raw color functions in Tailwind utility
// brackets — catches shadow-[0_5px_14px_rgba(43,37,32,0.07)], bg-[hsl(0,0%,50%)] etc.
// Allows wrapped tokens like shadow-[var(--xxx)] or shadow-[color-mix(in srgb, var(...) 50%, transparent)].
// Note: no \b before (rgba|hsla)—Tailwind arbitrary values use _ as space which is a word char,
// so \b doesn't match between _ and r/h.
const arbitraryRawColorFnPattern =
  /\b(?:bg|text|border|ring|divide|from|to|via|outline|shadow|accent|decoration|fill|stroke)-\[[^[\]]*(?<![a-zA-Z])(?:rgba?|hsla?)\s*\(/;

// Hex in style props
const hexPattern = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/;

// F056 Phase E AC-E11: oklch() literal in style props (e.g. style={{ color: 'oklch(0.5 0.15 30)' }})
const oklchLiteralPattern = /\boklch\s*\(/i;

// Allowed semantic prefixes (cat tokens, cafe tokens, werewolf tokens, F056 Phase E token families)
const SEMANTIC_PREFIXES = [
  // Cat persona tokens
  'opus',
  'codex',
  'gemini',
  'kimi',
  'cocreator',
  // Cafe + werewolf
  'cafe',
  'ww',
  // F056 Phase E — OKLCH 七类色 design system primitives
  'neutral',
  'accent',
  'semantic',
  'chart',
  'avatar-fallback',
  'brand',
];
const semanticPattern = new RegExp(`\\b(?:${TW_PREFIXES.join('|')})-(?:${SEMANTIC_PREFIXES.join('|')})-`);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow hardcoded color values; use design tokens instead (F056)',
    },
    messages: {
      noRawTailwindColor:
        'Hardcoded Tailwind color "{{value}}" — use a semantic token (e.g., bg-surface, text-primary, border-default). See F056 design token contract.',
      noArbitraryColor: 'Arbitrary color "{{value}}" — define a CSS variable and use a Tailwind token instead.',
      noHexInStyle: 'Hex color "{{value}}" in style prop — use a CSS variable (var(--xxx)) or design token.',
      noArbitraryOklch:
        'Arbitrary oklch() in className "{{value}}" — define a CSS variable in theme-tokens.css and use a Tailwind token instead. (F056 Phase E AC-E11)',
      noOklchInStyle:
        'Inline oklch() in style prop "{{value}}" — define a CSS variable in theme-tokens.css and reference via var(--xxx). (F056 Phase E AC-E11)',
      noArbitraryRawColorFn:
        'Arbitrary rgba/hsl color function in Tailwind utility "{{value}}" — define a CSS variable (e.g., --xxx-shadow) and use shadow-[var(--xxx-shadow)] instead. (F056 Phase E)',
    },
    schema: [],
  },

  create(context) {
    function checkStringForColors(node, value) {
      if (typeof value !== 'string') return;

      // Split into class names for Tailwind checks
      const classes = value.split(/\s+/);
      for (const cls of classes) {
        // Skip semantic tokens
        if (semanticPattern.test(cls)) continue;

        // Check raw Tailwind colors
        if (rawColorPattern.test(cls)) {
          context.report({ node, messageId: 'noRawTailwindColor', data: { value: cls } });
        }

        // Check arbitrary colors
        if (arbitraryColorPattern.test(cls)) {
          context.report({ node, messageId: 'noArbitraryColor', data: { value: cls } });
        }

        // F056 Phase E AC-E11: arbitrary oklch() in className
        if (arbitraryOklchPattern.test(cls)) {
          context.report({ node, messageId: 'noArbitraryOklch', data: { value: cls } });
        }

        // 砚砚 round-5 P2: arbitrary value containing raw color function (rgba/rgb/hsla/hsl)
        if (arbitraryRawColorFnPattern.test(cls)) {
          context.report({ node, messageId: 'noArbitraryRawColorFn', data: { value: cls } });
        }
      }
    }

    function checkHexInStyleValue(node, value) {
      if (typeof value !== 'string') return;
      // Skip CSS variable references
      if (value.includes('var(--')) return;

      const match = value.match(hexPattern);
      if (match) {
        context.report({ node, messageId: 'noHexInStyle', data: { value: match[0] } });
      }

      // F056 Phase E AC-E11: inline oklch() literal in style values
      if (oklchLiteralPattern.test(value)) {
        context.report({ node, messageId: 'noOklchInStyle', data: { value } });
      }
    }

    /** Recursively walk an expression to find all string literals/template quasis */
    function visitExpression(expr) {
      if (!expr) return;
      switch (expr.type) {
        case 'Literal':
          if (typeof expr.value === 'string') {
            checkStringForColors(expr, expr.value);
          }
          break;
        case 'TemplateLiteral':
          for (const quasi of expr.quasis) {
            checkStringForColors(quasi, quasi.value.raw);
          }
          // Also visit embedded expressions
          for (const e of expr.expressions) {
            visitExpression(e);
          }
          break;
        case 'ConditionalExpression':
          visitExpression(expr.consequent);
          visitExpression(expr.alternate);
          break;
        case 'LogicalExpression':
          visitExpression(expr.left);
          visitExpression(expr.right);
          break;
        case 'CallExpression':
          for (const arg of expr.arguments) {
            visitExpression(arg);
          }
          break;
      }
    }

    return {
      // Check className string literals: className="bg-white text-gray-700"
      JSXAttribute(node) {
        if (node.name.name !== 'className') return;

        // String literal
        if (node.value?.type === 'Literal' && typeof node.value.value === 'string') {
          checkStringForColors(node.value, node.value.value);
        }

        // Expression container: recurse into the full expression tree
        if (node.value?.type === 'JSXExpressionContainer') {
          visitExpression(node.value.expression);
        }
      },

      // Check style prop hex values: style={{ color: '#xxx' }}
      Property(node) {
        // Only check inside JSX style attributes
        if (!isInsideStyleProp(node)) return;

        if (node.value?.type === 'Literal' && typeof node.value.value === 'string') {
          checkHexInStyleValue(node.value, node.value.value);
        }
        if (node.value?.type === 'TemplateLiteral') {
          for (const quasi of node.value.quasis) {
            checkHexInStyleValue(quasi, quasi.value.raw);
          }
        }
      },
    };

    function isInsideStyleProp(node) {
      let current = node.parent;
      while (current) {
        if (current.type === 'JSXAttribute' && current.name?.name === 'style') return true;
        if (current.type === 'JSXElement' || current.type === 'Program') return false;
        current = current.parent;
      }
      return false;
    }
  },
};

module.exports = rule;
