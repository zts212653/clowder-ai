import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeFinishedWorktree } from './lib/worktree-direct-release.mjs';
import { fixture, git, idle } from './lib/worktree-finish-fixture.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { createReleaseArchive } from './lib/worktree-release-archive.mjs';
import {
  appendRelease,
  automaticReleasePaused,
  automaticReleaseTransactions,
  reconcileAutomaticReleases,
} from './lib/worktree-release-transactions.mjs';

test('removing journal record is synced while the original checkout still exists', () => {
  const f = fixture();
  const originalSync = fs.fsyncSync;
  try {
    const path = f.make('durable-removing');
    const root = join(f.root, '.reaper-quarantine');
    let observed = false;
    mock.method(fs, 'fsyncSync', (fd) => {
      const last = readFileSync(join(root, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
      if (last.phase === 'removing') {
        assert(existsSync(path), 'journal durability barrier must precede native deletion');
        observed = true;
      }
      return originalSync(fd);
    });
    syncBuiltinESMExports();
    removeFinishedWorktree({
      repo: f.repo,
      root,
      actor: 'worktree-lifecycle',
      authorizationRef: 'pr:fixture/repo#42',
      entry: {
        path,
        head: git(path, 'rev-parse', 'HEAD').trim(),
        lifecycle: lifecycleConfig(path, '--worktree'),
        finishSourceRef: 'pr:fixture/repo#42',
      },
      validate() {},
    });
    assert.equal(observed, true);
    assert.equal(existsSync(path), false);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a stale preserving record cannot discard originals after partial deletion', () => {
  const f = fixture();
  try {
    const path = f.make('lost-removing-record');
    writeFileSync(join(path, '.env.local'), 'ONLY_ORIGINAL=survive\n');
    const head = git(path, 'rev-parse', 'HEAD').trim();
    const lifecycle = lifecycleConfig(path, '--worktree');
    const txn = randomUUID();
    const archivePath = join(f.root, '.worktree-release-archives', txn);
    createReleaseArchive({
      repo: f.repo,
      txn,
      archivePath,
      entry: { path, head, lifecycle, finishSourceRef: 'pr:fixture/repo#42' },
    });
    const st = lstatSync(path);
    appendRelease(join(f.root, '.reaper-quarantine'), {
      repo: f.repo,
      action: 'release',
      txn,
      from: path,
      removedPath: path,
      head,
      owner: lifecycle.owner,
      sourceRef: 'pr:fixture/repo#42',
      archivePath,
      restore: 'fixture restoration entry',
      performedBy: 'worktree-lifecycle',
      state: 'pending',
      phase: 'preserving',
      sourceIdentity: { dev: st.dev, ino: st.ino },
      lifecycle,
    });
    // The newest journal record was lost; source HEAD/identity survive but ignored originals do not.
    rmSync(join(path, '.env.local'));
    reconcileAutomaticReleases(f.repo, { cwdProbe: idle, alive: () => false });
    assert.equal(existsSync(archivePath), true);
    assert.equal(readFileSync(join(archivePath, 'files/.env.local'), 'utf8'), 'ONLY_ORIGINAL=survive\n');
    assert.equal(automaticReleaseTransactions(f.repo)[0].state, 'interrupted');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('three automatic final-probe refusals leave no duplicate originals archives', () => {
  const f = fixture();
  try {
    const path = f.make('late-consumer');
    writeFileSync(join(path, '.env.local'), 'PRIVATE_FIXTURE_VALUE=preserved\n');
    for (let attempt = 0; attempt < 3; attempt++) {
      let probes = 0;
      assert.throws(
        () =>
          removeFinishedWorktree({
            repo: f.repo,
            root: join(f.root, '.reaper-quarantine'),
            actor: 'worktree-lifecycle',
            authorizationRef: 'pr:fixture/repo#42',
            entry: {
              path,
              name: basename(path),
              head: git(path, 'rev-parse', 'HEAD').trim(),
              lifecycle: lifecycleConfig(path, '--worktree'),
              finishSourceRef: 'pr:fixture/repo#42',
            },
            validate() {
              if (++probes === 2) throw new Error('late consumer');
            },
          }),
        /late consumer/,
      );
      assert.equal(existsSync(path), true);
      assert.equal(readFileSync(join(path, '.env.local'), 'utf8'), 'PRIVATE_FIXTURE_VALUE=preserved\n');
    }
    assert.deepEqual(readdirSync(join(f.root, '.worktree-release-archives')), []);
    const rows = readFileSync(join(f.root, '.reaper-quarantine/ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(rows.filter((r) => r.state === 'aborted').length, 3);
    assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/catcafe-releases').trim(), '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SIGTERM during real original copying is reconciled without another archive attempt', async () => {
  const f = fixture();
  let child;
  try {
    const path = f.make('copy-interrupted');
    const head = git(path, 'rev-parse', 'HEAD').trim();
    git(
      path,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'owner-user',
        sourceRef: 'pr:fixture/repo#42',
        role: 'author',
      }),
    );
    mkdirSync(join(path, '.cat-cafe/originals'), { recursive: true });
    for (let i = 0; i < 400; i++) writeFileSync(join(path, '.cat-cafe/originals', `${i}.txt`), Buffer.alloc(8192, 65));
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const args=process.argv.slice(2),h=${JSON.stringify(head)};
if(args[0]==='repo')console.log('fixture/repo');else if(args.includes('--paginate'))console.log(h);else console.log(JSON.stringify({base:{repo:{full_name:'fixture/repo'}},state:'closed',merged:true,head:{sha:h},merge_commit_sha:h,commits:1,html_url:'https://github.com/fixture/repo/pull/42'}));`,
    );
    chmodSync(join(bin, 'gh'), 0o700);
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./worktree-retire-merged.mjs', import.meta.url)),
        f.repo,
        path,
        head,
        'pr:fixture/repo#42',
        'thread_original',
        'owner-user',
        'codex61-sol',
      ],
      {
        stdio: 'ignore',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAT_CAFE_DATA_DIR: join(f.root, 'data') },
      },
    );
    const closed = once(child, 'close');
    const archives = join(f.root, '.worktree-release-archives');
    let partial;
    const until = Date.now() + 20000;
    while (Date.now() < until && child.exitCode === null && child.signalCode === null) {
      for (const name of existsSync(archives) ? readdirSync(archives) : []) {
        const candidate = join(archives, name);
        if (
          !existsSync(join(candidate, 'manifest.json')) &&
          existsSync(join(candidate, 'files/.cat-cafe/originals')) &&
          readdirSync(join(candidate, 'files/.cat-cafe/originals')).length > 0
        )
          partial = candidate;
      }
      if (partial) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(partial, 'interrupt an actual copy before its manifest, not a hand-written pending fixture');
    child.kill('SIGTERM');
    assert.equal((await closed)[1], 'SIGTERM');
    await new Promise((r) => setTimeout(r, 100)); // the one in-flight cp may outlive its parent briefly
    const ledger = join(f.root, '.reaper-quarantine/ledger.jsonl');
    const records = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    records.at(-1).processPid = process.pid; // The old writer PID was reused by an unrelated live process.
    writeFileSync(ledger, `${records.map(JSON.stringify).join('\n')}\n`);
    f.finish(path, {
      mode: 'retain',
      sourceRef: 'pr:fixture/repo#42',
      reason: 'owner resumed acceptance',
      until: new Date(Date.now() + 3600000).toISOString(),
    });
    mkdirSync(join(archives, 'foreign'));
    writeFileSync(join(archives, 'foreign/keep'), 'unrelated originals');
    const recovery = reconcileAutomaticReleases(f.repo, { cwdProbe: idle });
    assert.equal(recovery.reconciled, 1);
    assert.equal(existsSync(partial), false);
    assert.equal(existsSync(join(archives, 'foreign/keep')), true);
    assert.equal(readdirSync(join(path, '.cat-cafe/originals')).length, 400);
    assert.equal(lifecycleConfig(path, '--worktree').retention.reason, 'owner resumed acceptance');
    assert.equal(automaticReleasePaused(f.repo, path, head), true);
    assert.equal(automaticReleaseTransactions(f.repo)[0].state, 'aborted');
    assert.equal(reconcileAutomaticReleases(f.repo, { cwdProbe: idle }).reconciled, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a native refusal after originals disappear keeps the sole recovery copy and pauses retries', () => {
  const f = fixture();
  try {
    const path = f.make('partial-removal');
    writeFileSync(join(path, '.env.local'), 'ONLY_ORIGINAL=keep\n');
    let probes = 0;
    assert.throws(
      () =>
        removeFinishedWorktree({
          repo: f.repo,
          root: join(f.root, '.reaper-quarantine'),
          actor: 'worktree-lifecycle',
          authorizationRef: 'pr:fixture/repo#42',
          entry: {
            path,
            name: basename(path),
            head: git(path, 'rev-parse', 'HEAD').trim(),
            lifecycle: lifecycleConfig(path, '--worktree'),
            finishSourceRef: 'pr:fixture/repo#42',
          },
          validate() {
            if (++probes === 2) {
              rmSync(join(path, '.env.local'));
              writeFileSync(join(path, 'new-draft.txt'), 'forces native no-force refusal');
            }
          },
        }),
      /git worktree remove refused/,
    );
    const [r] = automaticReleaseTransactions(f.repo);
    assert.equal(r.state, 'interrupted');
    assert.equal(readFileSync(join(r.archivePath, 'files/.env.local'), 'utf8'), 'ONLY_ORIGINAL=keep\n');
    assert.equal(automaticReleasePaused(f.repo, path, r.head), true);
    assert.equal(reconcileAutomaticReleases(f.repo, { cwdProbe: idle }).reconciled, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
