import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('edge-extractors', () => {
  let extractWikiLinkEdges, extractFeatureRefEdges, extractDocLinkEdges;

  before(async () => {
    ({ extractWikiLinkEdges, extractFeatureRefEdges, extractDocLinkEdges } = await import(
      '../../dist/domains/memory/edge-extractors.js'
    ));
  });

  describe('extractWikiLinkEdges (AC-C1)', () => {
    it('extracts wikilinks from content', () => {
      const content = 'See [[F186]] for details and also [[F102]].';
      const edges = extractWikiLinkEdges(content, 'F188');
      assert.equal(edges.length, 2);
      assert.equal(edges[0].fromAnchor, 'F188');
      assert.equal(edges[0].toAnchor, 'F186');
      assert.equal(edges[0].relation, 'wikilink');
      assert.equal(edges[0].provenance, 'content');
      assert.equal(edges[1].toAnchor, 'F102');
    });

    it('deduplicates case-insensitively', () => {
      const edges = extractWikiLinkEdges('[[Foo]] and [[foo]] and [[FOO]]', 'bar');
      assert.equal(edges.length, 1);
      assert.equal(edges[0].toAnchor, 'Foo');
    });

    it('skips self-references', () => {
      const edges = extractWikiLinkEdges('See [[F188]] itself', 'F188');
      assert.equal(edges.length, 0);
    });

    it('skips self-references case-insensitively (cloud-P2)', () => {
      const edges = extractWikiLinkEdges('See [[f188]] itself', 'F188');
      assert.equal(edges.length, 0, 'lowercase self-ref should be skipped');
    });

    it('handles display text syntax [[target|display]]', () => {
      const edges = extractWikiLinkEdges('[[F186|Library Spec]]', 'F188');
      assert.equal(edges.length, 1);
      assert.equal(edges[0].toAnchor, 'F186');
    });

    it('returns empty for content without wikilinks', () => {
      const edges = extractWikiLinkEdges('plain text with no links', 'F188');
      assert.equal(edges.length, 0);
    });
  });

  describe('extractFeatureRefEdges (AC-C3)', () => {
    it('extracts F-number references', () => {
      const content = 'Related to F186 and F102, see also F042.';
      const edges = extractFeatureRefEdges(content, 'F188');
      assert.equal(edges.length, 3);
      assert.equal(edges[0].toAnchor, 'F186');
      assert.equal(edges[0].relation, 'feature_ref');
      assert.equal(edges[1].toAnchor, 'F102');
      assert.equal(edges[2].toAnchor, 'F042');
    });

    it('skips self-references', () => {
      const edges = extractFeatureRefEdges('This is F188 itself', 'F188');
      assert.equal(edges.length, 0);
    });

    it('deduplicates repeated references', () => {
      const edges = extractFeatureRefEdges('F186 is great. See F186 again.', 'F188');
      assert.equal(edges.length, 1);
    });

    it('handles 2-3 digit F-numbers', () => {
      const edges = extractFeatureRefEdges('F42 F186', 'F188');
      assert.equal(edges.length, 2);
    });

    it('does not match inside wikilinks', () => {
      const edges = extractFeatureRefEdges('[[F186]] standalone F102', 'F188');
      assert.ok(!edges.find((e) => e.toAnchor === 'F186'), 'F186 inside [[]] should be skipped');
      assert.ok(
        edges.find((e) => e.toAnchor === 'F102'),
        'standalone F102 should be extracted',
      );
    });

    it('does not match F-numbers inside wikilink display text (P2)', () => {
      const edges = extractFeatureRefEdges('[[Target|F186 Display]] standalone F102', 'F188');
      assert.ok(!edges.find((e) => e.toAnchor === 'F186'), 'F186 in wikilink display text should be skipped');
      assert.ok(edges.find((e) => e.toAnchor === 'F102'));
    });

    it('does not match F-numbers inside markdown link text (P2)', () => {
      const edges = extractFeatureRefEdges('[F186 spec](features/F186.md) standalone F102', 'F188');
      assert.ok(!edges.find((e) => e.toAnchor === 'F186'), 'F186 in markdown link text should be skipped');
      assert.ok(edges.find((e) => e.toAnchor === 'F102'));
    });

    it('does not match F-numbers in YAML frontmatter (P2)', () => {
      const content = '---\nfeature_ids: [F186]\nrelated_features: [F042]\n---\n\nBody with standalone F102';
      const edges = extractFeatureRefEdges(content, 'F188');
      assert.ok(!edges.find((e) => e.toAnchor === 'F186'), 'F186 in frontmatter should be skipped');
      assert.ok(!edges.find((e) => e.toAnchor === 'F042'), 'F042 in frontmatter should be skipped');
      assert.ok(
        edges.find((e) => e.toAnchor === 'F102'),
        'F102 in body should be extracted',
      );
    });
  });

  describe('extractFeatureRefEdges canonical resolver (AC-J5)', () => {
    it('zero-pads short F numbers: F20 → F020', () => {
      const edges = extractFeatureRefEdges('文档引用 F20 和 F186', 'other');
      assert.equal(edges.length, 2);
      assert.equal(edges[0].toAnchor, 'F020');
      assert.equal(edges[1].toAnchor, 'F186');
    });

    it('F020 already canonical is no-op', () => {
      const edges = extractFeatureRefEdges('已经是 F020 的引用', 'other');
      assert.equal(edges.length, 1);
      assert.equal(edges[0].toAnchor, 'F020');
    });

    it('filters year-like F2025 (num > 999)', () => {
      const edges = extractFeatureRefEdges('年份 F2025 不是 feature', 'other');
      assert.equal(edges.length, 0);
    });

    it('rejects F32-b (hyphen suffix via lookahead)', () => {
      const edges = extractFeatureRefEdges('F32-b 不是合法 anchor', 'other');
      assert.equal(edges.length, 0);
    });

    it('creates edge for unknown F998 (unresolved is ok at extraction)', () => {
      const edges = extractFeatureRefEdges('不存在的 F998', 'other');
      assert.equal(edges.length, 1);
      assert.equal(edges[0].toAnchor, 'F998');
    });
  });

  describe('extractDocLinkEdges (AC-C2)', () => {
    it('extracts markdown links matching known paths', () => {
      const pathToAnchor = new Map([['features/F186-library-memory-architecture.md', 'F186']]);
      const content = 'See [Library](features/F186-library-memory-architecture.md) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].toAnchor, 'F186');
      assert.equal(edges[0].relation, 'doc_link');
      assert.equal(edges[0].provenance, 'content');
    });

    it('strips leading ./ and ../ for matching', () => {
      const pathToAnchor = new Map([['features/F186-library.md', 'F186']]);
      const content = 'See [spec](../features/F186-library.md)';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 1);
    });

    it('skips http links', () => {
      const pathToAnchor = new Map();
      const edges = extractDocLinkEdges('[link](https://example.com)', 'F188', pathToAnchor);
      assert.equal(edges.length, 0);
    });

    it('skips anchor-only links', () => {
      const pathToAnchor = new Map();
      const edges = extractDocLinkEdges('[section](#heading)', 'F188', pathToAnchor);
      assert.equal(edges.length, 0);
    });

    it('skips self-references', () => {
      const pathToAnchor = new Map([['features/F188-stewardship.md', 'F188']]);
      const content = '[self](features/F188-stewardship.md)';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 0);
    });

    it('deduplicates links to same anchor', () => {
      const pathToAnchor = new Map([['features/F186-library.md', 'F186']]);
      const content = '[a](features/F186-library.md) [b](features/F186-library.md)';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 1);
    });

    it('strips fragment and query from link path before lookup (cloud-P1)', () => {
      const pathToAnchor = new Map([['features/F136-unified-config.md', 'F136']]);
      const content = 'See [config](features/F136-unified-config.md#hot-reload) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 1, 'should match after stripping #fragment');
      assert.equal(edges[0].toAnchor, 'F136');
    });

    it('resolves relative paths from source directory (P1-2)', () => {
      const pathToAnchor = new Map([['features/F186-library.md', 'F186']]);
      const content = 'See [Library](F186-library.md) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor, 'features/F188-test.md');
      assert.equal(edges.length, 1, 'should resolve F186-library.md relative to features/ dir');
      assert.equal(edges[0].toAnchor, 'F186');
    });

    it('resolves repo-root absolute links /docs/... (cloud-P1-4)', () => {
      const pathToAnchor = new Map([['features/F056-design-language.md', 'F056']]);
      const content = 'See [design](/docs/features/F056-design-language.md) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor);
      assert.equal(edges.length, 1, '/docs/ prefix should be stripped to match docs-relative key');
      assert.equal(edges[0].toAnchor, 'F056');
    });

    it('does not create false edges from over-traversed relative paths (cloud-P1-3)', () => {
      const pathToAnchor = new Map([['features/F186-library.md', 'F186']]);
      const content = 'See [Library](../../features/F186-library.md) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor, 'plans/test-plan.md');
      assert.equal(edges.length, 0, 'resolved path ../features/F186-library.md is outside tree, should not match');
    });

    it('uses POSIX path semantics for Windows cross-platform consistency (cloud-P2-windows)', () => {
      const pathToAnchor = new Map([['features/F186-library.md', 'F186']]);
      const content = 'See [Library](F186-library.md) for details.';
      const edges = extractDocLinkEdges(content, 'F188', pathToAnchor, 'features/F188-test.md');
      assert.equal(
        edges.length,
        1,
        'POSIX dirname must produce "features" on Windows too (was using node:path default which uses backslash on Windows)',
      );
      assert.equal(edges[0].toAnchor, 'F186');
    });
  });
});
