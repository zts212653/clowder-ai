import { expect, it } from 'vitest';
import { maskLeadingMarkdownFrontmatter } from '../markdown-frontmatter';

it.each([
  ['opening fence whitespace', '--- \t\ntitle: metadata\n---\n# Body', '# Body'],
  ['closing fence whitespace', '---\ntitle: metadata\n--- \t\n# Body', '# Body'],
  ['closing fence at EOF', '---\ntitle: metadata\n---', ''],
])('hides metadata with %s while preserving source positions', (_label, source, body) => {
  const masked = maskLeadingMarkdownFrontmatter(source);
  expect(masked.trim()).toBe(body);
  expect(masked).toHaveLength(source.length);
  expect([...masked.matchAll(/\n/g)].map((match) => match.index)).toEqual(
    [...source.matchAll(/\n/g)].map((match) => match.index),
  );
  expect(maskLeadingMarkdownFrontmatter(masked)).toBe(masked);
});

it('keeps the entire body, including later thematic breaks, after the first closing fence', () => {
  const body = '# Body\n\nFirst paragraph.\n\n---\n\nLast paragraph.';
  const source = `---\ntitle: metadata\n---\n${body}`;
  const masked = maskLeadingMarkdownFrontmatter(source);
  const bodyOffset = source.indexOf('# Body');
  expect(masked.slice(bodyOffset)).toBe(body);
  expect(masked.slice(0, bodyOffset).trim()).toBe('');
  expect(masked).toHaveLength(source.length);
});
