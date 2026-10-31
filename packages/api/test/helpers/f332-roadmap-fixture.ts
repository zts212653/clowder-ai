import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { fixture } from './f332-directory-fixture.js';
export async function setup(t: TestContext) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'f332-roadmap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  await mkdir(join(root, 'docs'));
  await writeFile(
    join(root, 'docs/roadmap.md'),
    '---\nupdated: 2026-10-20（候选）\n---\n# Original roadmap\nKeep the accepted decision.\n',
  );
  git('add', '.');
  git('-c', 'user.name=F332 QA', '-c', 'user.email=f332@example.invalid', 'commit', '-m', 'original roadmap');
  const thread = f.threadStore.create('owner', 'title does not name the model', root);
  const source = f.messageStore.append({
    userId: 'owner',
    threadId: thread.id,
    from: { kind: 'user', userId: 'owner' },
    content: 'Use this original roadmap',
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await f.registry.create('owner', createCatId('codex61-sol'), thread.id);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const sourceRef = `thread:${thread.id}#${source.id}`;
  const post = (roadmap: object, extra: object = {}) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/set-thread-metadata',
      headers,
      payload: { roadmap, ...extra },
    });
  const bind = () =>
    post({ state: 'active', projectPath: root, path: 'docs/roadmap.md', sourceRef, expectedRevision: null });
  const directory = async () =>
    (await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers }))
      .json()
      .threads.find((row: { threadId: string }) => row.threadId === thread.id);
  return { ...f, root, git, thread, sourceRef, headers, post, bind, directory };
}
