import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';
import { classifyShellSegment } from '../../../scripts/native-effect-shell-classifier.mjs';
import { isConstrainedSqliteRead } from '../../../scripts/native-effect-sqlite-classifier.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { secretShellDenial } from '../../../scripts/native-secret-shell.mjs';

// Natural incidents 863/062/242: classification only, never run their SQL or commands.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-natural-observation-')));
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
for (const path of [runtime, ordinary]) mkdirSync(path);
after(() => rmSync(root, { recursive: true, force: true }));

function admission(command, expected) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const result = decideNativeHookPayload(
      { tool_name, cwd: ordinary, tool_input: { command, cmd: command } },
      { selfHost: () => ({ confidence: 'none' }) },
    );
    assert.equal(result.decision, expected, `${command}\n${JSON.stringify(result)}`);
  }
  const native = decideAgyNativeHookPayload(
    { toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: ordinary } }, workspacePaths: [ordinary] },
    { selfHost: () => ({ confidence: 'none' }) },
  );
  assert.equal(native.decision, expected, `${command}\n${JSON.stringify(native)}`);
}

test('builtin program inquiries keep queried names as data, including destructive names and paths', () => {
  for (const prefix of ['command -v', 'command -V', 'command -pv', 'builtin command -v', 'command command -v']) {
    const command = `${prefix} gh rm git ${runtime}/scripts/runtime-stop.mjs`;
    const parsed = executedInvocations(command, { builtinContext: true });
    assert.equal(parsed.complete, true, command);
    const calls = parsed.pipelines.flat();
    assert.equal(calls.length, 1, command);
    assert.equal(calls[0].program, 'command', command);
    assert.equal(calls[0].lookupOnly, true, command);
    assert.equal(classifyShellSegment(command), 'read', command);
    assert.equal(secretShellDenial(command, ordinary), null, command);
    admission(command, 'allow');
  }
  admission('command -v gh', 'allow');
});

test('lookup does not exempt redirections, substitutions, later sends, or external command lookalikes', () => {
  admission(`command -v gh > ${runtime}/lookup.txt`, 'deny');
  admission(`command -v gh; printf changed > ${runtime}/changed`, 'deny');
  for (const command of [
    `command -v $(/opt/unmanaged/gh pr comment 1 --body unsafe)`,
    `command -v gh; /opt/unmanaged/gh pr comment 1 --body unsafe`,
    `command -p /opt/unmanaged/gh pr comment 1 --body unsafe`,
    `${root}/command -v gh pr comment 1 --body unsafe`,
    'env command -v gh pr comment 1 --body unsafe',
  ]) {
    assert.notEqual(secretShellDenial(command, ordinary), null, command);
    admission(command, 'deny');
  }
  for (const command of ['command -- -v gh', 'command -x gh', 'exec command -v gh'])
    assert.ok(
      !executedInvocations(command)
        .pipelines.flat()
        .some((call) => call.lookupOnly),
      command,
    );
});

test('readonly SQLite metadata can tighten its connection without writing the database', () => {
  const query =
    "PRAGMA query_only=ON; SELECT 'schema', max(version) FROM schema_version; SELECT 'index', name, sql FROM sqlite_master WHERE type='index' AND tbl_name='dynamic_task_defs'; SELECT 'stats', idx, stat FROM sqlite_stat1 WHERE tbl='dynamic_task_defs';";
  const command = `sqlite3 -readonly ${runtime}/evidence.sqlite "${query}"`;
  assert.equal(isConstrainedSqliteRead(command), true);
  assert.equal(classifyShellSegment(command), 'read');
  admission(command, 'allow');
  for (const pragma of [
    'PRAGMA query_only',
    'PRAGMA query_only=TRUE',
    'PRAGMA query_only(1)',
    'PRAGMA main.query_only = YES',
  ])
    admission(`sqlite3 "file:${runtime}/evidence.sqlite?mode=ro" "${pragma}; SELECT 1;"`, 'allow');
});

test('query_only is not proof for unknown SQL, output writes, extensions or writable DB mode', () => {
  for (const query of [
    'PRAGMA query_only=OFF; SELECT 1',
    'PRAGMA query_only=unknown; SELECT 1',
    'PRAGMA query_only=ON; DELETE FROM example',
    'PRAGMA query_only=ON; PRAGMA wal_checkpoint',
    "PRAGMA query_only=ON; SELECT writefile('/tmp/export', 'data')",
    "PRAGMA query_only=ON; SELECT load_extension('/tmp/unproved')",
    '.output /tmp/export',
  ]) {
    const command = `sqlite3 -readonly ${runtime}/evidence.sqlite "${query}"`;
    assert.equal(isConstrainedSqliteRead(command), false, command);
    admission(command, 'deny');
  }
  admission(`sqlite3 ${runtime}/evidence.sqlite "PRAGMA query_only=ON; SELECT 1"`, 'deny');
  admission(
    `sqlite3 -readonly ${runtime}/evidence.sqlite "PRAGMA query_only=ON; SELECT 1" > ${runtime}/export`,
    'deny',
  );
});

test('function bindings and unproved shell namespaces cannot certify builtin inquiries', () => {
  for (const prefix of [
    'command() { shift; "$@"; }',
    'function command { shift; "$@"; }',
    'command() { printf harmless; }',
    'source /tmp/unproved-functions',
    'alias command=unproved',
    'enable -n command',
  ]) {
    const command = `${prefix}; command -v rm -rf ${runtime}`;
    admission(command, 'deny');
    assert.ok(
      !executedInvocations(command)
        .pipelines.flat()
        .some((call) => call.lookupOnly),
      command,
    );
  }
  const command = 'command() { shift; "$@"; }; command -v /opt/unmanaged/gh pr comment 1 --body unsafe';
  assert.equal(secretShellDenial(command, ordinary), 'secret_send_requires_managed_command');
  admission(command, 'deny');
  for (const suffix of [`printf '%s' "$(command -v rm -rf ${runtime})"`, `eval 'command -v rm -rf ${runtime}'`])
    admission(`command() { shift; "$@"; }; ${suffix}`, 'deny');
});

test('shell startup code and imported functions cannot turn lookup syntax into a data certificate', () => {
  for (const command of [
    `BASH_ENV=/tmp/unproved-functions bash -c 'command -v rm -rf ${runtime}'`,
    'BASH_ENV=/tmp/unproved-functions bash -c "command -v /opt/unmanaged/gh pr comment 1 --body unsafe"',
    `bash --rcfile /tmp/unproved-functions -ic 'command -v rm -rf ${runtime}'`,
    `ZDOTDIR=/tmp/unproved-functions zsh -c 'command -v rm -rf ${runtime}'`,
  ])
    admission(command, 'deny');
  for (const name of ['BASH_ENV', 'ENV', 'BASH_FUNC_command%%']) {
    const before = process.env[name];
    process.env[name] = '/tmp/unproved-functions';
    try {
      admission(`command -v rm -rf ${runtime}`, 'deny');
      assert.equal(
        secretShellDenial('command -v /opt/unmanaged/gh pr comment 1 --body unsafe', ordinary),
        'secret_send_requires_managed_command',
      );
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }
});
