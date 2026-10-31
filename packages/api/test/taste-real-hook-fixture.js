import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleService } from '../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { tasteMemoryId } from '../dist/domains/memory/taste/taste-memory-identity.js';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
import { createRemoteFixture, git, remoteHead } from './taste-publication-fixtures.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const ownerUserId = 'isolated-forget-owner';
export const sourcePath = 'docs/taste/vignettes/isolated-hook-forget.md';
export const tombstonePath = `docs/taste/tombstones/${createHash('sha256').update(sourcePath).digest('hex')}.json`;
export const content =
  '---\nwhen: 2026-10-26\nquotes: ["Own isolated sample"]\nscene: "Real hook forget regression"\ntags: ["isolated"]\ndimension: creative-craft\nprivacy: public\n---\n';
export const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
export const forgetCommand = {
  action: 'hard_forget',
  requestId: 'f221-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
  expectedRevision: revision,
  confirmed: true,
};

// Real repository hook + its actual tracked inputs, not a hook-shaped stub.
// Only small fixture history is cloned; there is no network or production write.
export function createRealHookFixture() {
  const fixture = createRemoteFixture();
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'biome.json',
    '.gitignore',
    'scripts/check-biome-version.mjs',
    'scripts/brand-dictionary-helper.mjs',
    'scripts/intake-from-opensource.sh',
    'scripts/lib/intake-gh-retry.sh',
    'scripts/lib/intake-brand-paths.mjs',
    'assets/brand-dictionary.yaml',
  ]) {
    mkdirSync(dirname(join(fixture.primary, path)), { recursive: true });
    writeFileSync(join(fixture.primary, path), readFileSync(join(repoRoot, path)));
  }
  mkdirSync(dirname(join(fixture.primary, sourcePath)), { recursive: true });
  writeFileSync(join(fixture.primary, sourcePath), content);
  writeFileSync(
    join(fixture.primary, 'docs/taste/index.md'),
    '# Taste Index\n\n- [**isolated**](vignettes/isolated-hook-forget.md)\n  - 场景：Real hook forget regression\n',
  );
  git(fixture.primary, ['add', '.']);
  git(fixture.primary, ['commit', '-m', 'seed isolated real-hook forget inputs']);
  git(fixture.primary, ['push', 'origin', 'main']);
  git(fixture.runtime, ['merge', '--ff-only', 'main']);
  git(fixture.runtime, ['config', 'core.hooksPath', join(repoRoot, '.githooks')]);
  writeFileSync(join(fixture.primary, 'human-wip.md'), 'staged operator work\n');
  git(fixture.primary, ['add', 'human-wip.md']);
  return fixture;
}

export function attachFixtureBiome(fixture, { version, binary } = {}) {
  const modules = join(fixture.runtime, 'node_modules');
  mkdirSync(join(modules, '@biomejs'), { recursive: true });
  mkdirSync(join(modules, '.bin'), { recursive: true });
  if (version) {
    mkdirSync(join(modules, '@biomejs/biome'));
    writeFileSync(join(modules, '@biomejs/biome/package.json'), JSON.stringify({ name: '@biomejs/biome', version }));
  } else {
    symlinkSync(realpathSync(join(repoRoot, 'node_modules/@biomejs/biome')), join(modules, '@biomejs/biome'), 'dir');
  }
  symlinkSync(binary ?? join(repoRoot, 'node_modules/.bin/biome'), join(modules, '.bin/biome'));
}

export function createRealHookLifecycle(fixture, options = {}) {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new TasteMemoryLifecycleStore(db);
  const repository = new FileTasteRepository(fixture.runtime);
  const writer = new TasteMemoryProjectionWriter(repository, options);
  let invalidations = 0;
  const service = new TasteMemoryLifecycleService({
    store,
    writer,
    coordinator: new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    }),
    targetLock: new SessionMutex(),
    lockKey: () => repository.approvalLockKey(),
    invalidateDerived: async () => {
      invalidations++;
    },
  });
  return {
    db,
    store,
    writer,
    repository,
    service,
    invalidations: () => invalidations,
    apply: () => service.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, forgetCommand),
  };
}

export function captureSourceState(fixture) {
  return [
    git(fixture.primary, ['rev-parse', 'HEAD']),
    git(fixture.primary, ['status', '--porcelain=v1']),
    git(fixture.runtime, ['rev-parse', 'HEAD']),
    git(fixture.runtime, ['status', '--porcelain=v1']),
    readFileSync(join(fixture.primary, sourcePath), 'utf8'),
  ];
}

export async function assertPublicationCleanup(fixture, run) {
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  const tracePath = join(fixture.root, 'git-trace.jsonl');
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    return await run();
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    const checkouts = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start' && event.argv?.[1] === 'clone')
      .map((event) => event.argv.at(-1))
      .filter((path) => path.includes('cat-cafe-taste-publish-'));
    assert.ok(checkouts.length > 0, 'exercise the real disposable Git checkout');
    for (const checkout of checkouts) assert.equal(existsSync(dirname(checkout)), false, 'remove the whole temp root');
  }
}

export function assertFailedForget(fixture, lifecycle, beforeHead, beforeSource) {
  assert.equal(remoteHead(fixture), beforeHead);
  assert.deepEqual(captureSourceState(fixture), beforeSource);
  assert.equal(lifecycle.store.isReadable(ownerUserId, sourcePath, revision), true);
  assert.equal(lifecycle.store.getOwnerActionEvidence(ownerUserId, sourcePath, forgetCommand.requestId), null);
  assert.equal(lifecycle.invalidations(), 0, 'failed publication cannot emit forgotten/invalidation');
}
