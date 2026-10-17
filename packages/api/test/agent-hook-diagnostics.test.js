import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncAgentHooks } from '../dist/agent-hooks/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hook-diagnostics-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const targetRoot = join(root, 'secret-home');
  const hooks = join(projectRoot, '.claude/hooks/user-level');
  await mkdir(hooks, { recursive: true });
  await mkdir(join(targetRoot, '.claude'), { recursive: true });
  for (const name of ['session-start-recall.sh', 'session-stop-check.sh']) {
    await writeFile(join(hooks, name), '#!/bin/bash\necho fixture\n');
  }
  return { projectRoot, targetRoot };
}

test('hook diagnostics cover writes, settings merge, owner guard and health without private content', async (t) => {
  const options = await fixture(t);
  const settings = join(options.targetRoot, '.claude/settings.json');
  await writeFile(settings, JSON.stringify({ env: { FIXTURE_SECRET: 'never-log-this-secret' } }));
  const events = [];
  const status = await syncAgentHooks({ ...options, diagnostics: (event) => events.push(event) });
  assert.equal(status.status, 'configured');
  for (const phase of [
    'hook-files-write',
    'claude-settings-merge',
    'capability-owner-check',
    'health-check',
    'hook-files-health',
    'claude-settings-health',
    'skills-health',
    'mcp-health',
    'codex-output-validate',
  ]) {
    assert.deepEqual(
      events.filter((event) => event.phase === phase).map((event) => event.state),
      ['started', 'completed'],
    );
  }
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'phase', 'state', 'systemCpuMs', 'userCpuMs']);
    for (const key of ['durationMs', 'userCpuMs', 'systemCpuMs'])
      assert.ok(Number.isFinite(event[key]) && event[key] >= 0);
  }
  assert.ok(!JSON.stringify(events).includes(options.targetRoot));
  assert.ok(!JSON.stringify(events).includes('never-log-this-secret'));
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).env.FIXTURE_SECRET, 'never-log-this-secret');
  assert.equal(existsSync(join(options.projectRoot, '.cat-cafe/capabilities.json')), false);
});

test('failed hook phase is diagnostic without raw errors and preserves the original failure', async (t) => {
  const options = await fixture(t);
  await rm(join(options.projectRoot, '.claude/hooks/user-level/session-start-recall.sh'));
  const events = [];
  await assert.rejects(syncAgentHooks({ ...options, diagnostics: (event) => events.push(event) }), /ENOENT/);
  assert.deepEqual(
    events.map((event) => [event.phase, event.state]),
    [
      ['hook-files-write', 'started'],
      ['hook-files-write', 'failed'],
    ],
  );
  assert.ok(!JSON.stringify(events).includes(options.projectRoot));
  assert.ok(!JSON.stringify(events).includes('ENOENT'));
});

test('diagnostic observer failure cannot change hook sync or owner admission', async (t) => {
  const options = await fixture(t);
  const result = await syncAgentHooks({
    ...options,
    diagnostics: () => {
      throw new Error('observer-secret');
    },
  });
  assert.equal(result.status, 'configured');
  assert.equal(existsSync(join(options.projectRoot, '.cat-cafe/capabilities.json')), false);
});
