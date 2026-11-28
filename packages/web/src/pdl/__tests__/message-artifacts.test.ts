// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Ref = { kind: string; repository?: string; id?: string; path?: string; key: string; label: string; url?: string };
function renderer() {
  const context = createContext({
    document,
    NodeFilter,
    URL,
    tc: (key: string) => key,
    treeIn() {},
    MD_REF: { resolve: null },
    WHO_DATA: { handleWho: () => null },
  });
  const core = readFileSync('public/pdl/engine/core.js', 'utf8');
  runInContext(core.match(/^function h\(.*$/m)![0], context);
  for (const file of ['markdown', 'artifact-references', 'message-artifacts'])
    runInContext(readFileSync('public/pdl/library/' + file + '.js', 'utf8'), context);
  const spans = runInContext('artifactReferenceSpans', context) as (
    text: string,
    repo: string,
  ) => Array<{ start: number; end: number; ref: Ref }>;
  const groups = runInContext('artifactReferenceGroups', context) as (
    refs: Ref[],
  ) => Array<{ kind: string; items: Ref[] }>;
  const decorate = runInContext('messageArtifactHtml', context) as (html: string, repo: string) => string;
  const markdown = runInContext('mdLite', context) as (text: string) => string;
  return {
    parse: (text: string) => groups(spans(text, 'acme/project').map((x) => x.ref)),
    render: (text: string) => {
      const root = document.createElement('div');
      root.innerHTML = decorate(markdown(text), 'acme/project');
      return root;
    },
    decorate,
  };
}
describe('message artifact references', () => {
  it('deduplicates by repository and identity and keeps different repositories separate', () => {
    const { parse } = renderer();
    const groups = parse('PR #12 https://github.com/acme/project/pull/12 #12 / #13 other/repo#12 Issue #13');
    expect(groups.map((g) => [g.kind, g.items.map((r) => r.repository + '#' + r.id)])).toEqual([
      ['pr', ['acme/project#12']],
      ['issue', ['acme/project#13', 'other/repo#12']],
    ]);
  });
  it('recognizes connected issue references, contextual short commits, full hashes and repo-relative files', () => {
    const sha = 'a'.repeat(40),
      { parse } = renderer();
    expect(
      parse('#2128/#2130 HEAD abc1234 commit: def5678 ' + sha + ' docs/report.md packages/web/src/app.ts').map((g) => [
        g.kind,
        g.items.length,
      ]),
    ).toEqual([
      ['commit', 3],
      ['issue', 2],
      ['file', 2],
    ]);
  });
  it('rejects lookalike hosts, arbitrary short hex, traversal paths and references embedded in other URLs', () => {
    const { parse } = renderer();
    expect(
      parse(
        'https://github.com.evil/acme/project/pull/12 https://example.com/commit/abcdef1234567 abcdef1 docs/../../private.md',
      ),
    ).toEqual([]);
  });
  it('preserves punctuation and meaningful link text, and moves only artifact destinations into one dock', () => {
    const root = renderer().render(
      '参见 [修复说明](https://github.com/acme/project/pull/12)。Issue #13 与 https://github.com/acme/project/issues/14，普通 [网站](https://example.com)。',
    );
    expect(root.querySelectorAll('[data-artifact-dock]')).toHaveLength(1);
    expect(root.querySelector('.artifact-inline--pr')?.textContent).toBe('修复说明');
    expect(root.querySelector('.md')?.textContent).toContain('，普通');
    expect(root.querySelector('.md a')?.getAttribute('href')).toBe('https://example.com');
    expect(root.querySelectorAll('[data-artifact-dock] a')).toHaveLength(3);
    expect(root.querySelectorAll('[data-artifact-dock] svg')).toHaveLength(2);
  });
  it('leaves fenced examples, inline commands, math and foreign links intact', () => {
    const root = renderer().render(
      '```sh\nPR #123 docs/example.md\n```\n`git show commit abc1234`\n[Read PR #12](https://example.com/guide)\n$$\n#999\n$$',
    );
    expect(root.querySelector('[data-artifact-dock]')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toContain('PR #123 docs/example.md');
    expect(root.querySelector('a')?.textContent).toBe('Read PR #12');
  });
  it('shortens complete commit and path values while preserving the original in the title', () => {
    const sha = 'a'.repeat(40),
      root = renderer().render('HEAD `' + sha + '`，报告 `docs/deep/report.md`。');
    expect(root.querySelector('.artifact-inline--commit')?.textContent).toBe('aaaaaaa');
    expect(root.querySelector('.artifact-inline--commit')?.getAttribute('title')).toBe(sha);
    expect(root.querySelector('.artifact-inline--commit')?.getAttribute('data-quote-source-text')).toBe(sha);
    expect(root.querySelector('.artifact-inline--file')?.textContent).toBe('report.md');
    expect(root.querySelector('[data-act="fileOpen"]')?.getAttribute('data-v')).toBe('docs/deep/report.md');
    expect(root.querySelector('[data-artifact-dock]')?.hasAttribute('data-quote-exclude')).toBe(true);
    expect(root.querySelector('[data-artifact-dock]')?.textContent).not.toMatch(/PR|Commit|Issue|产出与关联/);
  });
  it('recognizes a short hash following a formatted HEAD and does not fabricate a file extension', () => {
    const root = renderer().render('HEAD `abc1234`；`docs/diagram.pen`，packages/web/src/app.ts。');
    expect(root.querySelector('.artifact-inline--commit')?.textContent).toBe('abc1234');
    expect(root.querySelectorAll('[data-artifact-dock] [data-act="fileOpen"]')).toHaveLength(2);
  });
  it('escapes user text, uses safe destinations and keeps the dock idempotent', () => {
    const { decorate, render } = renderer();
    const root = render('PR #12 [x](javascript:alert(1)) <img src=x onerror=alert(1)> `docs/report.md`');
    expect(root.querySelector('img,script,[onclick],[onerror]')).toBeNull();
    const link = root.querySelector('[data-artifact-dock] a')!;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const twice = document.createElement('div');
    twice.innerHTML = decorate(root.innerHTML, 'acme/project');
    expect(twice.querySelectorAll('[data-artifact-dock]')).toHaveLength(1);
  });
  it('preserves explicit GitHub comment targets and collapses unambiguous short/full commit aliases', () => {
    const sha = 'abcdef1' + 'a'.repeat(33),
      { parse, render } = renderer();
    const parsed = parse('HEAD ' + sha + ' commit abcdef1');
    expect(parsed[0].items).toHaveLength(1);
    expect(parsed[0].items[0].id).toBe(sha);
    const root = render('[Comment](https://github.com/acme/project/issues/12#issuecomment-123) Issue #12');
    expect(root.querySelector('[data-artifact-dock] a')?.getAttribute('href')).toBe(
      'https://github.com/acme/project/issues/12#issuecomment-123',
    );
  });
  it('keeps a path with spaces as one preview target and a full tooltip', () => {
    const root = renderer().render('报告 `docs/design/space name.md`。');
    expect(root.querySelector('.artifact-inline--file')?.textContent).toBe('space name.md');
    expect(root.querySelector('.artifact-inline--file')?.getAttribute('title')).toBe('docs/design/space name.md');
    expect(root.querySelector('[data-artifact-dock] button')?.getAttribute('data-v')).toBe('docs/design/space name.md');
  });
  it('keeps the HEAD wording and never silently re-roots a path or a nested pull locator', () => {
    const { parse, render } = renderer();
    expect(parse('/outside/docs/report.md other/repo/pull/12')).toEqual([]);
    expect(parse('notdocs/report.md')[0].items[0].path).toBe('notdocs/report.md');
    expect(render('HEAD abc1234').querySelector('.artifact-prose')?.textContent).toBe('HEAD abc1234');
  });
  it('treats a hash in a filename as a file, including paths with spaces', () => {
    const sha = 'a'.repeat(40),
      { parse, render } = renderer();
    expect(parse('docs/' + sha + '.md').map((group) => group.kind)).toEqual(['file']);
    expect(render('`docs/space dir/' + sha + '.md`').querySelector('[data-artifact-dock] a')).toBeNull();
  });
  it('includes root documents and source directories without interpreting runtime names as files', () => {
    const { parse } = renderer();
    expect(parse('README.md `package.json` src/main.ts Node.js')[0].items.map((ref) => ref.path)).toEqual([
      'README.md',
      'package.json',
      'src/main.ts',
    ]);
  });
  it('opens the actual file when a source reference includes a line number', () => {
    const root = renderer().render('见 `docs/SOP.md:12`。');
    expect(root.querySelector('[data-act="fileOpen"]')?.getAttribute('data-v')).toBe('docs/SOP.md');
    expect(root.querySelector('.artifact-inline--file')?.getAttribute('data-quote-source-text')).toBe('docs/SOP.md:12');
  });
});
