import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createWorkspaceContentReviewComposition } from '../src/domains/collaborative-content/workspace-review/composition.js';
import {
  WorkspaceContentSourceError,
  WorkspaceContentSourceService,
} from '../src/domains/workspace/workspace-content-source.js';
import { listWorktrees, registerWorktrees } from '../src/domains/workspace/workspace-security.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
}

async function readSnapshot(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `f309-${name}-`));
  roots.push(path);
  return path;
}

function source(entries: Record<string, string>, canonicalIds: Record<string, string> = {}) {
  return new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async (worktreeId) => {
      const resolved = entries[worktreeId];
      if (!resolved) throw new WorkspaceContentSourceError('not_found');
      return { root: resolved, canonicalWorktreeId: canonicalIds[worktreeId] ?? worktreeId };
    },
  });
}

describe('WorkspaceContentSourceService', () => {
  it('mints root-scoped content identity and a full source digest for same-named files', async () => {
    const [left, right] = await Promise.all([root('left'), root('right')]);
    const bytes = Buffer.from('first full media payload');
    await Promise.all([writeFile(join(left, 'cover.png'), bytes), writeFile(join(right, 'cover.png'), bytes)]);
    const service = source({ left, right });

    const [first, second] = await Promise.all([
      service.describe({ principal: { userId: 'operator' }, locator: { worktreeId: 'left', path: 'cover.png' } }),
      service.describe({ principal: { userId: 'operator' }, locator: { worktreeId: 'right', path: 'cover.png' } }),
    ]);

    assert.notEqual(first.contentRef, second.contentRef, 'different roots must not coalesce by file name');
    assert.equal(first.revision, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  });

  it('canonicalizes equivalent locators before minting the owner content identity', async () => {
    const workspace = await root('canonical-locator');
    await mkdir(join(workspace, 'nested'));
    await writeFile(join(workspace, 'notes.md'), 'one canonical file');
    const service = source({ workspace });

    const [direct, dot, parent] = await Promise.all(
      ['notes.md', './notes.md', 'nested/../notes.md'].map((path) =>
        service.describe({ principal: { userId: 'operator' }, locator: { worktreeId: 'workspace', path } }),
      ),
    );

    assert.equal(dot.contentRef, direct.contentRef);
    assert.equal(parent.contentRef, direct.contentRef);
    assert.deepEqual(dot.locator, direct.locator);
    assert.deepEqual(parent.locator, direct.locator);
    assert.equal(direct.locator.path, 'notes.md');
  });

  it('mints a canonical worktree locator that remains readable after source recreation', async () => {
    const workspace = await root('canonical-worktree-id');
    await writeFile(join(workspace, 'notes.md'), 'cold root recovery');
    const discoveryLocator = { worktreeId: 'a1b2c3_workspace-alpha', path: 'notes.md' };
    const first = source(
      { [discoveryLocator.worktreeId]: workspace },
      { [discoveryLocator.worktreeId]: 'workspace-alpha' },
    );
    const opened = await first.describe({ principal: { userId: 'operator' }, locator: discoveryLocator });
    assert.deepEqual(opened.locator, { worktreeId: 'workspace-alpha', path: 'notes.md' });

    const restarted = source({ 'workspace-alpha': workspace });
    const recovered = await restarted.describe({ principal: { userId: 'operator' }, locator: opened.locator });

    assert.equal(recovered.contentRef, opened.contentRef);
    assert.equal(recovered.revision, opened.revision);
  });

  it('does not turn a discovery-only foreign root into a durable F309 source', async () => {
    const [foreignRoot, dataDir] = await Promise.all([root('foreign-discovery'), root('foreign-discovery-data')]);
    await writeFile(join(foreignRoot, 'notes.md'), 'foreign discovery content');
    const worktreeId = `foreign-${Date.now()}`;
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    registerWorktrees([{ id: worktreeId, root: foreignRoot, branch: 'foreign', head: 'fixture' }]);
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    const composition = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
    try {
      await assert.rejects(
        composition.source.describe({
          principal: { userId: 'operator' },
          locator: { worktreeId, path: 'notes.md' },
        }),
        (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'not_found',
      );
    } finally {
      composition.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  it('uses only the configured workspace inventory rather than the process checkout', async () => {
    const [configuredRoot, dataDir] = await Promise.all([root('configured-root'), root('configured-root-data')]);
    await execFileAsync('git', ['init', configuredRoot]);
    await execFileAsync('git', ['-C', configuredRoot, 'config', 'user.email', 'f309-test@example.invalid']);
    await execFileAsync('git', ['-C', configuredRoot, 'config', 'user.name', 'F309 Test']);
    await writeFile(join(configuredRoot, 'notes.md'), 'configured workspace content');
    await execFileAsync('git', ['-C', configuredRoot, 'add', 'notes.md']);
    await execFileAsync('git', ['-C', configuredRoot, 'commit', '-m', 'fixture']);
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const [configuredEntries, currentEntries] = await Promise.all([listWorktrees(configuredRoot), listWorktrees()]);
    const configured = configuredEntries[0];
    const processRoot = resolve(process.cwd(), '../..');
    const current = currentEntries.find((entry) => entry.root === processRoot);
    assert.ok(configured, 'configured root must be represented in its own inventory');
    assert.ok(current, 'test process checkout must be represented in its current inventory');
    process.env.CAT_CAFE_WORKSPACE_ROOT = configuredRoot;
    const composition = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
    try {
      await assert.rejects(
        composition.source.describe({
          principal: { userId: 'operator' },
          locator: { worktreeId: current.id, path: 'package.json' },
        }),
        (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'not_found',
      );
      const configuredDescription = await composition.source.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: configured.id, path: 'notes.md' },
      });
      assert.equal(configuredDescription.kind, 'text');
    } finally {
      composition.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  it('keeps an explicit linked root exact instead of admitting its Git siblings', async () => {
    const repoRoot = await root('linked-root-exact-repo');
    const siblingRoot = join(repoRoot, 'sibling');
    const dataDir = await root('linked-root-exact-data');
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const originalLinkedRoots = process.env.WORKSPACE_LINKED_ROOTS;
    await execFileAsync('git', ['init', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'f309-test@example.invalid']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'F309 Test']);
    await writeFile(join(repoRoot, 'README.md'), 'linked root fixture\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'fixture']);
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', 'linked-sibling', siblingRoot]);
    await writeFile(join(siblingRoot, 'notes.md'), 'unlinked sibling content\n');
    await execFileAsync('git', ['-C', siblingRoot, 'add', 'notes.md']);
    await execFileAsync('git', ['-C', siblingRoot, 'commit', '-m', 'add sibling content']);
    const siblingCanonicalRoot = await realpath(siblingRoot);
    const sibling = (await listWorktrees(repoRoot)).find((entry) => entry.root === siblingCanonicalRoot);
    assert.ok(sibling, 'fixture sibling must be discoverable before it is denied as a linked root');
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.WORKSPACE_LINKED_ROOTS = `fixture:${repoRoot}`;
    const composition = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
    try {
      await assert.rejects(
        composition.source.describe({
          principal: { userId: 'operator' },
          locator: { worktreeId: sibling.id, path: 'notes.md' },
        }),
        (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'not_found',
      );
      const exactLinked = await composition.source.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: 'linked_fixture', path: 'README.md' },
      });
      assert.equal(exactLinked.kind, 'text');
    } finally {
      composition.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
      if (originalLinkedRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
      else process.env.WORKSPACE_LINKED_ROOTS = originalLinkedRoots;
    }
  });

  it('recovers a legacy alias scoped to a configured Git sibling', async () => {
    const repoRoot = await root('configured-sibling-alias-repo');
    const siblingRoot = join(repoRoot, 'sibling');
    const dataDir = await root('configured-sibling-alias-data');
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    await execFileAsync('git', ['init', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'f309-test@example.invalid']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'F309 Test']);
    await writeFile(join(repoRoot, 'README.md'), 'configured sibling fixture\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'fixture']);
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', 'configured-sibling', siblingRoot]);
    await writeFile(join(siblingRoot, 'notes.md'), 'configured sibling content\n');
    await execFileAsync('git', ['-C', siblingRoot, 'add', 'notes.md']);
    await execFileAsync('git', ['-C', siblingRoot, 'commit', '-m', 'add sibling content']);
    const siblingCanonicalRoot = await realpath(siblingRoot);
    const sibling = (await listWorktrees(repoRoot)).find((entry) => entry.root === siblingCanonicalRoot);
    assert.ok(sibling, 'configured sibling must be in the configured Git inventory');
    const prefix = createHash('sha256').update(sibling.root).digest('hex').slice(0, 6);
    process.env.CAT_CAFE_WORKSPACE_ROOT = repoRoot;
    const composition = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
    try {
      const description = await composition.source.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: `${prefix}_${sibling.id}`, path: 'notes.md' },
      });
      assert.match(description.locator.worktreeId, /^f063_root_v1_[a-f0-9]{64}$/u);
    } finally {
      composition.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  it('persists a root-derived locator across a same-name worktree head advance', async () => {
    const repoRoot = await root('stable-worktree-id-repo');
    const firstWorktree = join(repoRoot, 'first', 'same');
    const secondWorktree = join(repoRoot, 'second', 'same');
    const dataDir = await root('stable-worktree-id-data');
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    await mkdir(repoRoot, { recursive: true });
    await execFileAsync('git', ['init', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'f309-test@example.invalid']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'F309 Test']);
    await writeFile(join(repoRoot, 'README.md'), 'stable identity fixture\n');
    await execFileAsync('git', ['-C', repoRoot, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'fixture']);
    await mkdir(join(repoRoot, 'first'), { recursive: true });
    await mkdir(join(repoRoot, 'second'), { recursive: true });
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', 'stable-first', firstWorktree]);
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', 'stable-second', secondWorktree]);

    const initial = await listWorktrees(repoRoot);
    const changing = initial.find((entry) => basename(entry.root) === 'same' && /^same_[a-f0-9]{8}$/u.test(entry.id));
    assert.ok(changing, 'one same-named worktree must use the current-HEAD disambiguator');
    await writeFile(join(changing.root, 'notes.md'), 'durable locator content\n');
    await execFileAsync('git', ['-C', changing.root, 'add', 'notes.md']);
    await execFileAsync('git', ['-C', changing.root, 'commit', '-m', 'add content']);

    const beforeAdvance = (await listWorktrees(repoRoot)).find((entry) => entry.root === changing.root);
    assert.ok(beforeAdvance, 'changed worktree must remain in the configured inventory');
    process.env.CAT_CAFE_WORKSPACE_ROOT = repoRoot;
    const principal = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
    const first = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
    let firstClosed = false;
    try {
      const opened = await first.reviews.prepare({
        principal,
        locator: { worktreeId: beforeAdvance.id, path: 'notes.md' },
        operationId: 'stable-worktree-prepare',
      });
      const persistedLocator = opened.review.source.locator;
      assert.match(persistedLocator.worktreeId, /^f063_root_v1_[a-f0-9]{64}$/u);
      assert.notEqual(persistedLocator.worktreeId, beforeAdvance.id);
      first.store.close();
      firstClosed = true;

      await writeFile(join(changing.root, 'advance.md'), 'advance HEAD without changing the reviewed source\n');
      await execFileAsync('git', ['-C', changing.root, 'add', 'advance.md']);
      await execFileAsync('git', ['-C', changing.root, 'commit', '-m', 'advance worktree head']);
      const afterAdvance = (await listWorktrees(repoRoot)).find((entry) => entry.root === changing.root);
      assert.ok(afterAdvance, 'advanced worktree must remain in the configured inventory');
      assert.notEqual(afterAdvance.id, beforeAdvance.id, 'the legacy UI id must change with HEAD');

      const restarted = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
      try {
        const view = await restarted.reviews.read({ principal, reviewId: opened.review.reviewId });
        assert.equal(view.sourceState, 'current');
        assert.deepEqual(view.currentSource?.locator, persistedLocator);
      } finally {
        restarted.store.close();
      }
    } finally {
      if (!firstClosed) first.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  it('recovers a legacy configured locator through the production F063 composition without warm discovery', async () => {
    const repoRoot = resolve(process.cwd(), '../..');
    const entries = await listWorktrees(repoRoot);
    const current = entries.find((entry) => entry.root === repoRoot);
    assert.ok(current, 'test worktree must be listed from its configured workspace root');
    const originalWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.CAT_CAFE_WORKSPACE_ROOT = repoRoot;
    const prefix = createHash('sha256').update(repoRoot).digest('hex').slice(0, 6);
    const composition = createWorkspaceContentReviewComposition({
      dataDir: await root('configured-legacy-data'),
      ownerUserId: 'operator',
    });
    try {
      const description = await composition.source.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: `${prefix}_${current.id}`, path: 'package.json' },
      });
      assert.match(description.locator.worktreeId, /^f063_root_v1_[a-f0-9]{64}$/u);
    } finally {
      composition.store.close();
      if (originalWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  it('refuses a symlinked intermediate directory that resolves outside the owner root', async () => {
    const [workspace, outside] = await Promise.all([root('intermediate-link'), root('outside')]);
    await mkdir(join(workspace, 'nested'));
    await writeFile(join(outside, 'secret.md'), 'not workspace content');
    await symlink(outside, join(workspace, 'nested', 'swap'));
    const service = source({ workspace });

    await assert.rejects(
      service.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: 'workspace', path: 'nested/swap/secret.md' },
      }),
      (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'access_denied',
    );
  });

  it('fails closed when a revision-bound source is replaced or the locator escapes its workspace', async () => {
    const workspace = await root('replacement');
    await writeFile(join(workspace, 'note.md'), 'stable content');
    const service = source({ workspace });
    const snapshot = await service.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'note.md' },
    });

    await writeFile(join(workspace, 'note.md'), 'replacement content');
    await assert.rejects(
      service.readText({
        principal: { userId: 'operator' },
        locator: { worktreeId: 'workspace', path: 'note.md' },
        expectedRevision: snapshot.revision,
      }),
      (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'revision_changed',
    );
    await assert.rejects(
      service.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: 'workspace', path: '../outside.md' },
      }),
      (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'access_denied',
    );
  });

  it('resolves Markdown selections against raw source rather than rendered DOM offsets', async () => {
    const workspace = await root('text-anchor');
    await writeFile(join(workspace, 'notes.md'), '# Notes\n\nunique **raw** quote\n\nrepeat\nrepeat\n');
    const service = source({ workspace });
    const snapshot = await service.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
    });

    const unique = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote: 'unique **raw** quote',
    });
    assert.equal(unique.status, 'attached');
    assert.equal(unique.anchor?.start, 9);

    const duplicate = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote: 'repeat',
    });
    assert.equal(duplicate.status, 'ambiguous');
  });

  // Parent Alpha 2026-09-25: "请猫修改" on a rendered selection over **bold** or across paragraphs was refused,
  // because the selection was matched against raw Markdown. It must map to the raw range behind it, or refuse.
  it('resolves a rendered-page selection to the raw range behind it, and refuses what it cannot prove', async () => {
    const workspace = await root('rendered-selection');
    const markdown =
      '# 松针\n\n第一段：**暮色里的灯塔**把航线折成两半，\nthe keeper writes.\n\nSecond — *salt*, 海风。\n\nrepeat\n\nrepeat\n';
    await writeFile(join(workspace, 'notes.md'), markdown);
    await writeFile(join(workspace, 'a.ts'), 'const bold = "**x**";\n');
    const service = source({ workspace });
    const principal = { userId: 'operator' };
    const revisionOf = async (path: string) =>
      (await service.describe({ principal, locator: { worktreeId: 'workspace', path } })).revision;
    const resolve = async (path: string, quote: string, expectedRevision?: string) =>
      service.resolveRenderedTextSelection({
        principal,
        locator: { worktreeId: 'workspace', path },
        expectedRevision: expectedRevision ?? (await revisionOf(path)),
        quote,
      });

    const crossing = await resolve('notes.md', '暮色里的灯塔把航线折成两半，\nthe keeper writes.\n\nSecond — salt');
    assert.equal(crossing.status, 'attached');
    const start = markdown.indexOf('暮色');
    const end = markdown.indexOf('salt') + 'salt'.length;
    assert.deepEqual([crossing.anchor?.start, crossing.anchor?.end], [start, end]);
    // The anchor names the raw source, so the later text write checks the file rather than the render.
    assert.equal(crossing.anchor?.quote, markdown.slice(start, end));

    // Raw has a blank line between paragraphs; the browser reports one newline or a space.
    assert.equal((await resolve('notes.md', 'writes. Second')).status, 'attached');
    assert.equal((await resolve('notes.md', 'repeat')).status, 'ambiguous');
    // Markup the reader never saw is not a rendered selection.
    assert.equal((await resolve('notes.md', '**暮色')).status, 'orphaned');
    // A code file shows its source, so its selection is matched raw, markup and all.
    const code = await resolve('a.ts', '"**x**"');
    assert.equal(code.status, 'attached');
    assert.equal(code.anchor?.start, 'const bold = '.length);
    await assert.rejects(
      resolve('notes.md', '暮色', `sha256:${'0'.repeat(64)}`),
      (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'revision_changed',
    );
  });

  it('fails closed for overlapping raw-text occurrences', async () => {
    const workspace = await root('text-anchor-overlap');
    await writeFile(join(workspace, 'notes.md'), 'aaa');
    const service = source({ workspace });
    const snapshot = await service.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
    });

    const overlap = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote: 'aa',
    });
    assert.equal(overlap.status, 'ambiguous');
  });

  it('fails closed when a stale text anchor has the same quote in unrelated context', async () => {
    const workspace = await root('text-remap-context');
    const quote = 'TARGET PHRASE';
    await writeFile(join(workspace, 'notes.md'), `ORIGINAL before ${quote} after ORIGINAL\n`);
    const service = source({ workspace });
    const snapshot = await service.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
    });
    const original = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote,
    });
    assert.equal(original.status, 'attached');
    if (!original.anchor) throw new Error('fixture must create a text anchor');

    await writeFile(join(workspace, 'notes.md'), `TOTALLY unrelated before ${quote} after TOTALLY unrelated\n`);
    const remapped = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote,
      allowRevisionDrift: true,
      expectedQuoteDigest: original.anchor.quoteDigest,
      expectedContextDigest: original.anchor.contextDigest,
    });
    assert.equal(remapped.status, 'orphaned');
  });

  it('uses persisted context digest to remap one matching quote among repeated candidates', async () => {
    const workspace = await root('text-remap-disambiguation');
    const quote = 'TARGET PHRASE';
    const originalText = `ORIGINAL before ${quote} ${'stable context '.repeat(12)}`;
    await writeFile(join(workspace, 'notes.md'), originalText);
    const service = source({ workspace });
    const snapshot = await service.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
    });
    const original = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote,
    });
    if (!original.anchor) throw new Error('fixture must create a text anchor');

    await writeFile(join(workspace, 'notes.md'), `${originalText}\nDIFFERENT before ${quote} different after`);
    const remapped = await service.resolveTextQuote({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'notes.md' },
      expectedRevision: snapshot.revision,
      quote,
      allowRevisionDrift: true,
      expectedQuoteDigest: original.anchor.quoteDigest,
      expectedContextDigest: original.anchor.contextDigest,
    });
    assert.equal(remapped.status, 'attached');
    assert.equal(remapped.anchor?.start, original.anchor.start);
  });

  it('refuses callers outside the F063 owner boundary', async () => {
    const workspace = await root('owner');
    await writeFile(join(workspace, 'note.md'), 'private');
    const service = source({ workspace });

    await assert.rejects(
      service.describe({
        principal: { userId: 'someone-else' },
        locator: { worktreeId: 'workspace', path: 'note.md' },
      }),
      (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'access_denied',
    );
  });

  it('issues an immutable no-store projection snapshot after a full revision-bound media check', async () => {
    const workspace = await root('media');
    const bytes = await tinyPng();
    await writeFile(join(workspace, 'cover.png'), bytes);
    const service = source({ workspace });
    const described = await service.describeMedia({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'cover.png' },
    });
    assert.equal(described.media.kind, 'image');
    assert.deepEqual(described.media, { kind: 'image', width: 1, height: 1 });

    const opened = await service.openMedia({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'workspace', path: 'cover.png' },
      expectedRevision: described.revision,
    });
    await writeFile(
      join(workspace, 'cover.png'),
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000000' } })
        .png()
        .toBuffer(),
    );
    const streamed = await readSnapshot(opened.stream);
    assert.equal(opened.revision, described.revision);
    assert.deepEqual(streamed, bytes, 'a post-open overwrite must not alter an already validated projection');
    assert.deepEqual(
      await sharp(streamed)
        .metadata()
        .then(({ width, height }) => ({ width, height })),
      {
        width: 1,
        height: 1,
      },
    );
  });
});
