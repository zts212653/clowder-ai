import type { SuggestedCrossPostAction } from '@cat-cafe/shared';

export function formatSuggestedCrossPostActionLines(
  action: SuggestedCrossPostAction,
  opts: {
    indent: string;
    detailIndent: string;
  },
): string[] {
  if (action.type !== 'cross_post') return [];
  if (!action.threadId && !action.targetCats?.length && !action.ownerCatId) return [];

  const threadId = action.threadId ?? '<feature-thread-id>';
  const args = [`threadId="${threadId}"`];
  if (action.targetCats?.length) args.push(`targetCats=${JSON.stringify(action.targetCats)}`);

  const contentPlaceholder = action.targetCats?.length ? '...' : '@target-cat\\n...';
  const lines = [
    `${opts.indent}suggested_action: cat_cafe_cross_post_message(${args.join(', ')}, content="${contentPlaceholder}")`,
  ];

  if (!action.targetCats?.length) {
    lines.push(`${opts.detailIndent}routing: replace @target-cat with the cat handle to wake in the target thread`);
  }
  if (!action.threadId) {
    lines.push(`${opts.detailIndent}routing: find the feature thread before sending`);
  }
  if (action.reason) lines.push(`${opts.detailIndent}reason: ${action.reason}`);
  return lines;
}
