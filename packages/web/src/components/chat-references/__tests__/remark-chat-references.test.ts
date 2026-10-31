import type { Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { expect, it } from 'vitest';
import { remarkChatReferences } from '../remark-chat-references';

function references(body: string) {
  const processor = unified().use(remarkParse).use(remarkChatReferences);
  const tree = processor.runSync(processor.parse(body)) as Root;
  return JSON.stringify(tree);
}
it('recognizes whole code paths including extensionless files; leaves shell statements and fenced code literal', () => {
  const tree = references('`README` and `cat docs/file.md`\n\n```sh\ndocs/fenced.md\n```');
  expect(tree).toContain('"data-chat-reference":"README"');
  expect(tree).not.toContain('"data-chat-reference":"cat docs/file.md"');
  expect(tree).not.toContain('"data-chat-reference":"docs/fenced.md"');
});
it('preserves prose punctuation and decodes only Markdown hrefs, keeping native percent names literal', () => {
  const tree = references(
    '入口：docs/report.md。 See docs/another.md. [Guide](docs/My%20Guide.md#L3) and `docs/100%20real.md`.',
  );
  for (const ref of ['docs/report.md', 'docs/another.md', 'docs/My Guide.md:3', 'docs/100%20real.md'])
    expect(tree).toContain(`"data-chat-reference":"${ref}"`);
});
it('recognizes Markdown reference links through their actual definition, retaining the same file admission', () => {
  const tree = references('[Report][notes]\n\n[notes]: docs/report.md#L8');
  expect(tree).toContain('"data-chat-reference":"docs/report.md:8"');
});
it('recognizes a trailing-slash directory in code, prose and a standalone Markdown link', () => {
  const tree = references('Open `docs/` here. Or docs/ here.\n\n[Directory](docs/)');
  expect(tree.match(/"data-chat-reference":"docs\/"/g)).toHaveLength(3);
  expect(tree).toContain('"data-chat-layout":"card"');
});
it('preserves a historical root hint in the reader coordinate while hiding it from inline code display', () => {
  const processor = unified().use(remarkParse).use(remarkChatReferences);
  const tree = processor.runSync(processor.parse('`docs/history.md[wt:old-root]`')) as Root;
  const link = tree.children[0];
  expect(JSON.stringify(link)).toContain('"data-chat-reference":"docs/history.md[wt:old-root]"');
  expect(JSON.stringify(link)).toContain('"children":[{"type":"text","value":"docs/history.md"}]');
});

it('keeps immediate brackets and closing punctuation with an inline reference without changing the prose', () => {
  const processor = unified().use(remarkParse).use(remarkChatReferences);
  const body = '已推送（`881135a8f8`），原稿 `F317-actions.md:42`。 [说明](docs/notes.md)!';
  const tree = processor.runSync(processor.parse(body)) as Root;
  const wrappers: string[] = [];
  function visit(node: { data?: { hProperties?: Record<string, unknown> }; children?: unknown[] }) {
    if (node.data?.hProperties?.['data-chat-reference-affix']) wrappers.push(JSON.stringify(node));
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(tree);
  expect(wrappers).toHaveLength(3);
  expect(wrappers[0]).toContain('（');
  expect(wrappers[0]).toContain('），');
  expect(wrappers[1]).toContain('。');
  expect(wrappers[2]).toContain('!');
  expect(JSON.stringify(tree)).not.toContain('"data-chat-layout":"card"');
});

it('leaves plain-prose closing punctuation outside file and commit candidates', () => {
  for (const suffix of ['!', '?', ':', '！', '？', '：']) {
    const tree = references(`Open notes.md${suffix} Then 881135a8f8${suffix}`);
    expect(tree).toContain('"data-chat-reference":"notes.md"');
    expect(tree).toContain('"data-chat-reference":"881135a8f8"');
  }
});
