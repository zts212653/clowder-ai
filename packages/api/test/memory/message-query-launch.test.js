import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareQualificationLaunch } from '../../dist/domains/memory/message-query-launch.js';
import { contentRevision, QUERY_QUALIFICATION_INSTRUCTIONS } from '../../dist/domains/memory/message-query-protocol.js';

const model = 'claude-haiku-5-5';
function launch(t) {
  const root = mkdtempSync(join(tmpdir(), 'qualification-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const l0 = join(root, 'full-l0');
  const appended = join(root, 'qualification');
  writeFileSync(l0, 'FULL-L0-CANARY\nAll original rules and identity remain.');
  writeFileSync(appended, QUERY_QUALIFICATION_INSTRUCTIONS);
  return {
    command: 'claude',
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      model,
      '--effort',
      'low',
      '--permission-mode',
      'plan',
      '--setting-sources',
      'project,local,user',
      '--tools',
      '',
      '--strict-mcp-config',
      '--system-prompt-file',
      l0,
      '--append-system-prompt-file',
      appended,
      '--settings',
      join(root, 'settings'),
    ],
    stdinInput: JSON.stringify({ query: 'PRIVATE-QUERY', rows: [{ body: 'PRIVATE-BODY' }] }),
    cwd: root,
    signal: new AbortController().signal,
    env: { CAT_CAFE_READONLY: 'true', CLAUDE_CODE_SAFE_MODE: '0' },
  };
}
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('qualification removes plan workflow while preserving full instructions, whole input and zero-tool read-only launch', (t) => {
  const original = launch(t);
  const before = structuredClone(original.args);
  const traces = [];
  const prepared = prepareQualificationLaunch(original, model, (event) => traces.push(event));
  assert.equal(value(prepared.args, '--permission-mode'), 'dontAsk');
  const expected = [...before, '--safe-mode'];
  expected[expected.indexOf('--permission-mode') + 1] = 'dontAsk';
  assert.deepEqual(prepared.args, expected, 'only the permission value and existing safe-mode flag change');
  assert.deepEqual(original.args, before, 'the shared carrier plan is not mutated');
  assert.equal(prepared.stdinInput, original.stdinInput);
  assert.equal(prepared.signal, original.signal);
  assert.equal(prepared.cwd, original.cwd);
  assert.equal(prepared.env.CAT_CAFE_READONLY, 'true');
  assert.equal(prepared.env.CLAUDE_CODE_SAFE_MODE, '1');
  assert.equal(prepared.bindExecutionOwner, false);
  assert.equal(value(prepared.args, '--tools'), '');
  assert.equal(value(prepared.args, '--effort'), 'low');
  assert.equal(value(prepared.args, '--model'), model);
  for (const flag of ['--system-prompt-file', '--append-system-prompt-file']) {
    const body = readFileSync(value(original.args, flag), 'utf8');
    assert.deepEqual(
      traces[0].instructions.find((row) => row.decision === flag),
      {
        decision: flag,
        chars: body.length,
        sha256: contentRevision(body),
      },
    );
  }
  assert.doesNotMatch(JSON.stringify(traces), /FULL-L0-CANARY|PRIVATE-|All original/);
});

for (const [label, change] of [
  [
    'effort changed',
    (args) => {
      args[args.indexOf('--effort') + 1] = 'high';
    },
  ],
  [
    'mode already changed',
    (args) => {
      args[args.indexOf('--permission-mode') + 1] = 'dontAsk';
    },
  ],
  ['duplicate mode', (args) => args.push('--permission-mode', 'bypassPermissions')],
  ['duplicate equals mode', (args) => args.push('--permission-mode=bypassPermissions')],
  ['duplicate model', (args) => args.push('--model', 'other-model')],
  ['duplicate tools', (args) => args.push('--tools', 'Bash')],
  ['duplicate effort', (args) => args.push('--effort', 'high')],
  ['MCP supplied', (args) => args.push('--mcp-config', '{}')],
  ['permission bypass', (args) => args.push('--dangerously-skip-permissions')],
  ['allowed tools override', (args) => args.push('--allowedTools', 'Bash')],
  ['resume', (args) => args.push('--resume', 'old-session')],
  ['prompt override', (args) => args.push('--system-prompt', 'replacement')],
]) {
  test(`qualification rejects ${label} before native launch`, (t) => {
    const original = launch(t);
    change(original.args);
    assert.throws(() => prepareQualificationLaunch(original, model), /Qualification launch mismatch/);
  });
}

test('qualification refuses missing or empty full instructions instead of substituting a short prompt', (t) => {
  const original = launch(t);
  writeFileSync(value(original.args, '--system-prompt-file'), '   ');
  assert.throws(() => prepareQualificationLaunch(original, model), /Qualification full instructions/);
});
