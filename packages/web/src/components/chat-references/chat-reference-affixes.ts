import type { Emphasis, PhrasingContent, RootContent } from 'mdast';

const opening = /[（(「『【《“‘]+$/u;
const closing = /^[。，、；：！？）」』】》”’.,;:!?)]*/u;

/** Keep prose punctuation in the same inline box without making it part of the link/action. */
export function attachReferenceAffixes(children: Array<RootContent | PhrasingContent>) {
  const result: Array<RootContent | PhrasingContent> = [];
  for (const [index, child] of children.entries()) {
    if (child.type !== 'link' || !child.data?.hProperties?.['data-chat-reference']) {
      result.push(child);
      continue;
    }
    const before = result.at(-1);
    const after = children[index + 1];
    const prefix = before?.type === 'text' ? (opening.exec(before.value)?.[0] ?? '') : '';
    const suffix = after?.type === 'text' ? (closing.exec(after.value)?.[0] ?? '') : '';
    if (!prefix && !suffix) {
      result.push(child);
      continue;
    }
    if (prefix && before?.type === 'text') {
      before.value = before.value.slice(0, -prefix.length);
      if (!before.value) result.pop();
    }
    if (suffix && after?.type === 'text') after.value = after.value.slice(suffix.length);
    const group: Emphasis = {
      type: 'emphasis',
      children: [
        ...(prefix ? [{ type: 'text' as const, value: prefix }] : []),
        child,
        ...(suffix ? [{ type: 'text' as const, value: suffix }] : []),
      ],
      data: {
        hName: 'span',
        hProperties: {
          'data-chat-reference-affix': true,
          className: 'inline-flex max-w-full items-baseline whitespace-nowrap',
        },
      },
    };
    result.push(group);
  }
  return result;
}
