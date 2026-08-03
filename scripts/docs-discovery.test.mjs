import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveDocsProfileScope } from './docs-discovery/lib/scope-resolver.mjs';
import { lintProfileForRepo } from './docs-discovery/lint-profile.mjs';
import { git, initGitRepo, makeRepo, rel, writeFixture } from './docs-discovery-test-helpers.mjs';

describe('F243 docs discovery scope resolver', () => {
  it('produces scanner, enforced, exempt, and overlay sets', () => {
    const root = makeRepo();
    try {
      writeFixture(root, 'docs/features/F999-good.md');
      writeFixture(root, 'docs/archive/2026-06-01/features/F001-archived.md');
      writeFixture(root, 'docs/features/index.md');
      writeFixture(root, 'docs/diagrams/map.svg');
      writeFixture(root, 'docs/mailbox/inbox.md');
      writeFixture(root, 'docs/lessons-learned.md');
      writeFixture(
        root,
        'cat-cafe-skills/feat-lifecycle/SKILL.md',
        '---\nname: feat-lifecycle\ndescription: Feature lifecycle\n---\n# Skill\n',
      );

      const scope = resolveDocsProfileScope(root, { resolvedAt: '2026-06-30T12:00:00Z' });
      assert.deepEqual(rel(root, scope.profile_enforced), [
        'cat-cafe-skills/feat-lifecycle/SKILL.md',
        'docs/features/F999-good.md',
      ]);
      assert.deepEqual(rel(root, scope.overlay_added), ['cat-cafe-skills/feat-lifecycle/SKILL.md']);
      assert.equal(
        scope.profile_exempt.find((entry) => entry.relativePath === 'docs/archive/2026-06-01/features/F001-archived.md')
          ?.reason,
        'archived_artifact',
      );
      assert.equal(
        scope.profile_exempt.find((entry) => entry.relativePath === 'docs/features/index.md')?.reason,
        'generated_artifact',
      );
      assert.equal(
        scope.profile_exempt.find((entry) => entry.relativePath === 'docs/diagrams/map.svg')?.reason,
        'asset_file',
      );
      assert.equal(
        scope.profile_exempt.find((entry) => entry.relativePath === 'docs/lessons-learned.md')?.reason,
        'generated_source_for_synthetic_LL_entries',
      );
      assert.equal(
        scope.scanner_discovered_files.some((entry) => entry.relativePath === 'docs/mailbox/inbox.md'),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes gitignored .md but keeps untracked non-ignored .md (Sol validation edge)', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(root, '.gitignore', 'docs/discussions/local-only/\n');
      writeFixture(root, 'docs/features/F999-tracked.md');
      writeFixture(root, 'docs/features/F998-untracked-not-ignored.md');
      writeFixture(root, 'docs/discussions/local-only/README.md');
      writeFixture(root, 'docs/discussions/local-only/notes.md');
      // Seed: track F999 + .gitignore; F998 and local-only/* stay untracked
      git(root, 'add', '.gitignore', 'docs/features/F999-tracked.md');
      git(root, 'commit', '-m', 'seed');

      const scope = resolveDocsProfileScope(root, { resolvedAt: '2026-07-10T03:20:00Z' });
      const enforcedPaths = rel(root, scope.profile_enforced);
      const scannerPaths = rel(root, scope.scanner_discovered_files);

      // ① ignored .md 不入任何集合 (scanner or enforced)
      assert.equal(
        scannerPaths.includes('docs/discussions/local-only/README.md'),
        false,
        'gitignored README should not appear in scanner_discovered_files',
      );
      assert.equal(
        scannerPaths.includes('docs/discussions/local-only/notes.md'),
        false,
        'gitignored notes.md should not appear in scanner_discovered_files',
      );
      // ② untracked-but-not-ignored .md 仍入 (Sol validation: 不能与 git ls-files 取交集)
      assert.ok(
        enforcedPaths.includes('docs/features/F998-untracked-not-ignored.md'),
        'untracked-but-not-ignored .md must remain in profile_enforced',
      );
      assert.ok(enforcedPaths.includes('docs/features/F999-tracked.md'), 'tracked .md still in profile_enforced');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws on ENOBUFS instead of silently reintroducing ignored files (cloud codex P2 — PR #2845)', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(root, '.gitignore', 'docs/features/\n');
      // Seed enough ignored .md paths that git check-ignore stdout will exceed a
      // deliberately tiny maxBuffer, triggering Node's ENOBUFS on spawnSync.
      // Without the fix, the fail-safe branch would return an empty ignored set
      // and reintroduce every ignored file into the index — the exact phantom
      // diff regression this feature guards against.
      for (let i = 0; i < 200; i += 1) {
        writeFixture(root, `docs/features/local-only-note-${i}.md`);
      }
      git(root, 'add', '.gitignore');
      git(root, 'commit', '-m', 'seed');

      assert.throws(
        () => resolveDocsProfileScope(root, { _testHooks: { maxBuffer: 32 } }),
        /git check-ignore stdout exceeded maxBuffer/,
        'ENOBUFS must fail closed, not silently return empty ignored set',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-git repo: fail-safe legacy behavior (no filter applied)', () => {
    // Repo without git init — git check-ignore should exit 128, treat as "cannot determine"
    const root = makeRepo();
    try {
      writeFixture(root, 'docs/features/F999-good.md');
      const scope = resolveDocsProfileScope(root, { resolvedAt: '2026-07-10T03:20:00Z' });
      const paths = rel(root, scope.profile_enforced);
      assert.ok(
        paths.includes('docs/features/F999-good.md'),
        'non-git repo: all discovered files kept (no gitignore inference possible)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F243 profile lint', () => {
  it('hard-fails new in-scope docs without profile fields but skips untouched legacy docs', () => {
    const root = makeRepo();
    try {
      writeFixture(root, 'docs/features/F999-legacy.md', '# F999: Legacy\n\nBody\n');
      writeFixture(root, 'docs/features/F998-new.md', '# F998: New\n\nBody\n');

      const result = lintProfileForRepo(root, {
        changedFiles: ['docs/features/F998-new.md'],
        newFiles: ['docs/features/F998-new.md'],
      });
      assert.equal(result.ok, false);
      assert.deepEqual(
        result.errors.map((diagnostic) => diagnostic.code),
        [
          'f243/missing-frontmatter',
          'f243/missing-description',
          'f243/missing-description-source',
          'f243/missing-description-author',
          'f243/missing-description-updated-at',
        ],
      );
      assert.equal(
        result.errors.some((diagnostic) => diagnostic.path.endsWith('F999-legacy.md')),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns on H1 changes and fails edited placeholder descriptions', () => {
    const root = makeRepo();
    try {
      writeFixture(
        root,
        'docs/features/F997-valid.md',
        [
          '---',
          'description: Stable identity',
          'description_source: human',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F997: New Title',
        ].join('\n'),
      );
      writeFixture(
        root,
        'docs/features/F996-placeholder.md',
        [
          '---',
          'description: TODO',
          'description_source: human',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F996: Placeholder',
        ].join('\n'),
      );

      const result = lintProfileForRepo(root, {
        changedFiles: ['docs/features/F997-valid.md', 'docs/features/F996-placeholder.md'],
        h1ChangedFiles: ['docs/features/F997-valid.md'],
        profileFieldChangedFiles: ['docs/features/F996-placeholder.md'],
      });
      assert.equal(result.ok, false);
      assert.deepEqual(
        result.warnings.map((diagnostic) => diagnostic.code),
        ['f243/body-h1-changed'],
      );
      assert.deepEqual(
        result.errors.map((diagnostic) => diagnostic.code),
        ['f243/placeholder-description'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hard-fails existing docs that add descriptions without provenance', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(root, 'docs/features/F995-description-only.md', '# F995: Description Only\n\nBody\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'seed legacy doc without profile');
      git(root, 'checkout', '-b', 'feature');
      writeFixture(
        root,
        'docs/features/F995-description-only.md',
        ['---', 'description: Added stable identity', '---', '# F995: Description Only'].join('\n'),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'add description without provenance');

      const result = lintProfileForRepo(root, { base: 'main' });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.errors.map((diagnostic) => diagnostic.code),
        ['f243/missing-description-source', 'f243/missing-description-author', 'f243/missing-description-updated-at'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows unrelated edits to legacy docs that already had descriptions without provenance', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(
        root,
        'docs/features/F994-legacy-description.md',
        ['---', 'description: Legacy stable identity', '---', '# F994: Legacy Description', '', 'Old body'].join('\n'),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'seed legacy description without provenance');
      git(root, 'checkout', '-b', 'feature');
      writeFixture(
        root,
        'docs/features/F994-legacy-description.md',
        ['---', 'description: Legacy stable identity', '---', '# F994: Legacy Description', '', 'Edited body'].join(
          '\n',
        ),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'edit legacy body only');

      const result = lintProfileForRepo(root, { base: 'main' });

      assert.equal(result.ok, true, result.errors.map((diagnostic) => diagnostic.code).join(', '));
      assert.deepEqual(result.errors, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows unrelated edits to legacy skill descriptions that are already too long', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      const legacyDescription =
        'This compatibility skill description predates the F243 profile gate and is intentionally far beyond the new concise description target so unrelated body edits must not be blocked.';
      writeFixture(
        root,
        'cat-cafe-skills/legacy/SKILL.md',
        ['---', 'name: legacy', `description: ${legacyDescription}`, '---', '# Legacy Skill', '', 'Old body'].join(
          '\n',
        ),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'seed legacy skill description');
      git(root, 'checkout', '-b', 'feature');
      writeFixture(
        root,
        'cat-cafe-skills/legacy/SKILL.md',
        ['---', 'name: legacy', `description: ${legacyDescription}`, '---', '# Legacy Skill', '', 'Edited body'].join(
          '\n',
        ),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'edit legacy skill body only');

      const result = lintProfileForRepo(root, { base: 'main' });

      assert.equal(result.ok, true, result.errors.map((diagnostic) => diagnostic.code).join(', '));
      assert.deepEqual(result.errors, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hard-fails edited docs with malformed frontmatter', () => {
    const root = makeRepo();
    try {
      writeFixture(
        root,
        'docs/features/F994-bad-frontmatter.md',
        ['---', 'description: [broken', '---', '# F994: Bad Frontmatter'].join('\n'),
      );

      const result = lintProfileForRepo(root, {
        changedFiles: ['docs/features/F994-bad-frontmatter.md'],
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.errors.map((diagnostic) => diagnostic.code),
        ['f243/invalid-frontmatter'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the diff base cannot be resolved', () => {
    const root = makeRepo();
    try {
      writeFixture(root, 'docs/features/F995-new.md', '# F995: New\n\nBody\n');

      assert.throws(() => lintProfileForRepo(root, { base: 'missing/base' }), /Unable to discover changed files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats rename destinations that enter profile scope as new docs', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(root, 'docs/mailbox/inbox.md', '# Inbox\n\nBody\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'seed out-of-scope doc');
      git(root, 'checkout', '-b', 'feature');
      mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
      git(root, 'mv', 'docs/mailbox/inbox.md', 'docs/features/F994-renamed.md');
      git(root, 'commit', '-m', 'rename doc into profile scope');

      const result = lintProfileForRepo(root, { base: 'main' });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.errors.map((diagnostic) => diagnostic.code),
        [
          'f243/missing-frontmatter',
          'f243/missing-description',
          'f243/missing-description-source',
          'f243/missing-description-author',
          'f243/missing-description-updated-at',
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives H1 and frontmatter drift warnings from the git diff', () => {
    const root = makeRepo();
    try {
      initGitRepo(root);
      writeFixture(
        root,
        'docs/features/F993-drift.md',
        [
          '---',
          'topics: [old]',
          'description: Stable identity',
          'description_source: human',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F993: Old Title',
        ].join('\n'),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'seed profiled doc');
      git(root, 'checkout', '-b', 'feature');
      writeFixture(
        root,
        'docs/features/F993-drift.md',
        [
          '---',
          'topics: [new]',
          'description: Stable identity',
          'description_source: human',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F993: New Title',
        ].join('\n'),
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'edit profiled doc identity hints');

      const result = lintProfileForRepo(root, { base: 'main' });

      assert.equal(result.ok, true);
      assert.deepEqual(result.warnings.map((diagnostic) => diagnostic.code).sort(), [
        'f243/body-h1-changed',
        'f243/frontmatter-key-changed',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
