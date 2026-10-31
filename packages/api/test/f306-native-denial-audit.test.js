import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('real shared entry appends one local denial with parsed target; allow stays silent', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'f306-denial-audit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = join(home, 'cat-cafe-runtime');
  const env = { ...process.env, HOME: home, CAT_CAFE_CAT_ID: 'audit-fixture' };
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  const run = (command) =>
    spawnSync(process.execPath, [join(root, 'scripts/native-effect-target-guard.mjs')], {
      input: JSON.stringify({ tool_name: 'exec_command', turn_id: 'audit', cwd: home, tool_input: { cmd: command } }),
      encoding: 'utf8',
      env,
    });
  const denied = run(`touch ${runtime}/blocked`);
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(runtime));
  const ledger = join(home, '.cat-cafe', 'guard-denials', 'native.jsonl');
  const before = readFileSync(ledger, 'utf8');
  const entry = JSON.parse(before);
  assert.equal(entry.catId, 'audit-fixture');
  assert.equal(entry.origin, 'test_process');
  assert.equal(entry.provider, 'codex');
  assert.equal(entry.reasonCode, 'runtime_sanctuary_mutation');
  assert.equal(entry.target.value, `${runtime}/blocked`);
  assert.ok(entry.commandSummary.length <= 240);
  assert.ok(Number.isFinite(Date.parse(entry.at)));
  assert.equal(run('printf ordinary').stdout, '');
  assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('audit redacts before truncation and an unavailable audit never changes policy', async (t) => {
  const { appendNativeDenial } = await import('../../../scripts/native-effect-audit.mjs');
  const home = mkdtempSync(join(tmpdir(), 'f306-audit-redaction-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const token = 'sk-proj-' + 'Q'.repeat(80);
  const verdict = {
    decision: 'deny',
    reasonCode: 'test',
    effect: 'unknown',
    target: { kind: 'ordinary', value: '/tmp' },
    source: { provider: 'unknown' },
  };
  appendNativeDenial({ turn_id: 'audit-codex', tool_input: { command: `echo ${token} ${'x'.repeat(500)}` } }, verdict, {
    homeDir: home,
  });
  const record = readFileSync(join(home, '.cat-cafe/guard-denials/native.jsonl'), 'utf8');
  assert.ok(!record.includes(token));
  assert.ok(JSON.parse(record).commandSummary.length <= 240);
  assert.equal(JSON.parse(record).provider, 'codex');
  let warned = false;
  appendNativeDenial({}, verdict, {
    homeDir: join(home, 'not-a-directory/..', 'missing'),
    warn: () => {
      warned = true;
    },
    append: () => {
      throw new Error('unavailable');
    },
  });
  assert.equal(warned, true);
});

test('AGY shared-target CLI denials carry the same parsed target and local audit', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'f306-agy-audit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, 'cat-cafe-runtime/blocked');
  const env = { ...process.env, HOME: home };
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  const result = spawnSync(process.execPath, [join(root, 'scripts/agy-native-effect-guard.mjs')], {
    env,
    encoding: 'utf8',
    input: JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: `touch ${target}`, Cwd: home } },
      workspacePaths: [home],
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).reason.includes(target));
  const entry = JSON.parse(readFileSync(join(home, '.cat-cafe/guard-denials/native.jsonl'), 'utf8'));
  assert.equal(entry.provider, 'agy');
  assert.equal(entry.target.value, target);
});
