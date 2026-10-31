import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KimiAgentService } from '../src/domains/cats/services/agents/providers/KimiAgentService.js';
import { OpenCodeAgentService } from '../src/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { invalidateCliCommand } from '../src/utils/cli-resolve.js';

test('Kimi exact import refuses an unknown native identity before spawning instead of starting fresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f322-kimi-exact-'));
  const priorPath = process.env.PATH;
  writeFileSync(join(root, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${root}:/usr/bin:/bin`;
  invalidateCliCommand('kimi-cli');
  invalidateCliCommand('kimi');
  let spawned = 0;
  const service = new KimiAgentService({
    model: 'kimi-code/k3',
    mcpServerPath: '',
    l0CompilerFn: async () => 'CURRENT_IDENTITY',
    spawnFn: () => {
      spawned++;
      throw new Error('probe stopped before native execution');
    },
  });
  try {
    const result = [];
    for await (const event of service.invoke('Continue', {
      sessionId: 'original',
      requireExactResume: true,
      callbackEnv: { KIMI_SHARE_DIR: root },
    }))
      result.push(event);
    assert.equal(spawned, 0);
    assert.ok(result.some((e) => e.type === 'error' && /Exact Kimi resume/.test(e.error ?? '')));
    assert.ok(!result.some((e) => e.type === 'session_init' || e.content?.includes('l0_resume_fresh_start')));
    // The ordinary pre-existing contract still takes its explicit fresh path.
    for await (const _event of service.invoke('Continue', {
      sessionId: 'original',
      callbackEnv: { KIMI_SHARE_DIR: root },
    })) {
      /* consume */
    }
    assert.equal(spawned, 1);
  } finally {
    process.env.PATH = priorPath;
    invalidateCliCommand('kimi-cli');
    invalidateCliCommand('kimi');
    rmSync(root, { recursive: true });
  }
});

test('OpenCode exact import rejects all configured session replacement spellings before spawn', async () => {
  let spawned = 0;
  const service = new OpenCodeAgentService({
    model: 'provider/model',
    spawnFn: () => {
      spawned++;
      throw new Error('must not spawn');
    },
  });
  for (const cliConfigArgs of [
    ['--session other'],
    ['-sother'],
    ['--continue'],
    ['--fork'],
    ['--attach=http://elsewhere'],
  ]) {
    await assert.rejects(async () => {
      for await (const _event of service.invoke('Continue', {
        sessionId: 'ses_original',
        requireExactResume: true,
        cliConfigArgs,
      })) {
        /* consume */
      }
    }, /Exact OpenCode resume/);
  }
  assert.equal(spawned, 0);
});
