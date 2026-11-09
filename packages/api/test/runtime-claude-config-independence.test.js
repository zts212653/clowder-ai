import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test(
  'Claude retains independently readable project settings when real SDK model discovery fails',
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-offline-catalog-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
    const overrides = ['ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CONFIG_DIR'];
    const previous = Object.fromEntries(overrides.map((key) => [key, process.env[key]]));
    overrides.forEach((key) => {
      delete process.env[key];
    });
    t.after(() =>
      overrides.forEach((key) => {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = join(root, 'isolated-user');
    mkdirSync(process.env.CLAUDE_CONFIG_DIR);
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'review-owned-offline-model',
        effortLevel: 'low',
        modelSettings: {
          'review-owned-offline-model': { effortLevel: 'high' },
          'review-owned-selected-model': { effortLevel: 'medium' },
        },
      }),
    );
    const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk');
    const snapshot = await resolveSettings({ cwd: root, settingSources: ['user', 'project', 'local'] });
    assert.equal(snapshot.effective.model, 'review-owned-offline-model');
    const started = join(root, 'query-started');
    const prompt = join(root, 'unexpected-prompt');
    const executable = join(root, 'offline-cli.js');
    writeFileSync(
      executable,
      `
if (process.argv.includes('--version')) console.log('2.1.312 (Claude Code)');
else {
  require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const event = JSON.parse(line);
    if (event.type === 'control_request') process.stdout.write(JSON.stringify({
      type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'owned offline discovery' }
    }) + '\\n');
    if (event.type === 'user') require('node:fs').writeFileSync(${JSON.stringify(prompt)}, 'unexpected');
  });
}
`,
    );
    chmodSync(executable, 0o755);
    const { probeRuntimeCatalog } = await import('../dist/routes/runtime-catalog-probe.js');
    const { createCatalogCache } = await import('../dist/routes/runtime-catalog-route.js');
    const cache = createCatalogCache(probeRuntimeCatalog);
    const result = await cache('offline-claude', {
      kind: 'claude',
      command: executable,
      args: [],
      cwd: root,
      model: 'review-owned-selected-model',
    });
    assert.equal(existsSync(started), true, 'the real SDK actually started the owned external program');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.defaultModel, 'review-owned-offline-model');
    assert.equal(result.defaultEffort, 'high');
    assert.equal(result.selectedEffort, 'medium');
    assert.equal(result.defaultModelSource, 'tool_config');
    assert.equal(existsSync(prompt), false, 'catalog discovery must not send a model prompt');
  },
);
