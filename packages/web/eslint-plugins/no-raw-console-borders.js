/** Existing F190 console border policy, enforced once by ESLint instead of 50 product test registrations. */
const DIVIDER_SCOPE = new Set([
  'workspace/ConsolePanel.tsx',
  'workspace/BrowserToolbar.tsx',
  'workspace/BrowserPanel.tsx',
  'workspace/DiffViewer.tsx',
  'memory/RecallFeed.tsx',
]);

const CARD_SCOPE = new Set([]);

const rawDivider = /\bborder-[tbrl]\s+border-\[var\(--console-border-soft\)\]/;
const rawCard = /\bborder\s+border-\[var\(--console-border-soft\)\]/;

module.exports = {
  // Let the rule's scope guard detect renamed/deleted files without copying the policy registry.
  scopedComponentPaths: [...new Set([...DIVIDER_SCOPE, ...CARD_SCOPE])],
  meta: {
    type: 'suggestion',
    docs: { description: 'Use semantic console dividers and card surfaces in the existing F190 scope.' },
    schema: [],
    messages: {
      divider: 'Use console-divider-* instead of a raw console-border-soft divider.',
      card: 'Use the shared console card surface instead of a raw console-border-soft container border.',
    },
  },
  create(context) {
    const filename = context.getFilename().replaceAll('\\', '/');
    const relative = filename.split('/src/components/').at(-1);
    const divider = DIVIDER_SCOPE.has(relative);
    const card = CARD_SCOPE.has(relative);
    if (!divider && !card) return {};

    function checkDivider(node, value) {
      if (divider && typeof value === 'string' && rawDivider.test(value)) {
        context.report({ node, messageId: 'divider' });
      }
    }

    return {
      Literal(node) {
        checkDivider(node, node.value);
        if (
          card &&
          node.parent?.type === 'JSXAttribute' &&
          node.parent.name.name === 'className' &&
          typeof node.value === 'string' &&
          rawCard.test(node.value)
        ) {
          context.report({ node, messageId: 'card' });
        }
      },
      TemplateElement(node) {
        checkDivider(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
