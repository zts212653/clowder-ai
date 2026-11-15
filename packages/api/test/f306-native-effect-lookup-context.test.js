import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';
import { hereDocumentView } from '../../../scripts/native-effect-heredoc.mjs';
import { decideShellHookPayload } from '../../../scripts/native-effect-shell-decision.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { secretShellDenial } from '../../../scripts/native-secret-shell.mjs';

// Review975 regression: only policy functions consume these strings.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-lookup-context-')));
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
const main = join(root, 'projects/relay-station/cat-cafe');
for (const path of [runtime, ordinary, main]) mkdirSync(path, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const options = { selfHost: () => ({ confidence: 'none' }) };

function decisions(command, cwd = ordinary) {
  return [
    ...['Bash', 'exec_command'].map(
      (tool_name) =>
        decideNativeHookPayload({ tool_name, cwd, tool_input: { command, cmd: command } }, options).decision,
    ),
    decideAgyNativeHookPayload(
      { toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } }, workspacePaths: [cwd] },
      options,
    ).decision,
  ];
}

function verify(commands, expected, cwd) {
  const results = commands.map((command) => ({ command, actual: decisions(command, cwd) }));
  assert.deepEqual(
    results.filter((row) => row.actual.some((value) => value !== expected)),
    [],
    JSON.stringify(results),
  );
}

test('clustered query flags preserve native data roles but never hide unproved execution', () => {
  for (const flags of ['-pv', '-vp', '-pV', '-Vp']) {
    verify([`command ${flags} gh rm ${runtime}/script`], 'allow');
    verify(
      [
        `command() { shift; "$@"; }; command ${flags} rm -rf ${runtime}`,
        `command() { shift; "$@"; }; command ${flags} /opt/unmanaged/gh pr comment 1 --body unsafe`,
        `BASH_ENV=/tmp/unproved bash -c "command ${flags} rm -rf ${runtime}"`,
        `env command ${flags} rm -rf ${runtime}`,
        `/tmp/command ${flags} /opt/unmanaged/gh pr comment 1 --body unsafe`,
      ],
      'deny',
    );
  }
});

test('external argv launchers cannot execute the native shell builtin', () => {
  verify(
    [
      'find /tmp -exec command -v /opt/unmanaged/gh pr comment 1 --body unsafe \\;',
      'pnpm exec command -v /opt/unmanaged/gh pr comment 1 --body unsafe',
      'npm exec -- command -v /opt/unmanaged/gh pr comment 1 --body unsafe',
      `pnpm exec command -v rm -rf ${runtime}`,
      `printf '%s\\n' x | xargs command -v rm -rf ${runtime}`,
      `printf '%s\\n' '/opt/unmanaged/gh pr comment 1 --body unsafe' | xargs command -v`,
    ],
    'deny',
  );
  verify([`printf '%s\\n' '/opt/unmanaged/gh pr comment 1 --body text' | xargs printf '%s\\n'`], 'allow');
});

test('xargs default and null transport retain different argv boundaries and launcher provenance', () => {
  const input = '/opt/unmanaged/gh pr comment 1 --body unsafe';
  for (const [command, source, program] of [
    ['xargs command -v', `${input}\n`, '/opt/unmanaged/gh'],
    ['xargs -0 command -v', `${input}\0`, input],
    ['xargs -0 command -v', '/opt/unmanaged/gh\n\0', '/opt/unmanaged/gh\n'],
  ]) {
    const reader = executedInvocations(command, {
      stdin: { source, evidence: ['owned input fixture'] },
      builtinContext: true,
    });
    const child = reader.pipelines.flat().find((call) => call.inputOwner === 'xargs');
    assert.equal(child.program, program);
    assert.ok(child.wrappers.some((wrapper) => wrapper.program === 'xargs'));
    assert.deepEqual(child.inputEvidence, ['owned input fixture']);
    assert.equal(child.lookupOnly, false);
  }
});

test('reparsed worktree and generated-control segments keep their parent namespace state', () => {
  verify(
    [
      'command() { shift; "$@"; }; command -v git worktree remove --force .',
      'source /tmp/unproved; command -v git worktree remove --force .',
      'source /tmp/unproved; command -v "$UNPROVED_PROGRAM" arg1',
      'alias command=eval; command -v "$UNPROVED_PROGRAM" arg1',
      'enable -n command; command -v "$(printf git)" reset --hard',
    ],
    'deny',
    main,
  );
  verify(['command -v git worktree remove --force .'], 'allow', main);
});

test('leading shell structure does not hide a function declaration', () => {
  for (const prefix of ['{ function command { shift; "$@"; }; }', '{ { function command { printf harmless; }; }; }']) {
    verify(
      [`${prefix}; command -v rm -rf ${runtime}`, `${prefix}; command -v /opt/unmanaged/gh pr comment 1 --body unsafe`],
      'deny',
    );
    assert.ok(
      !executedInvocations(`${prefix}; command -v gh`, { builtinContext: true })
        .pipelines.flat()
        .some((call) => call.lookupOnly),
    );
  }
});

test('a reader without caller namespace proof cannot certify builtin lookup', () => {
  assert.ok(
    !executedInvocations('command -v gh')
      .pipelines.flat()
      .some((call) => call.lookupOnly),
  );
  assert.equal(secretShellDenial('command -v gh', ordinary), null);
  verify(['command -v gh', 'command -v gh; command -V git'], 'allow');
  const view = hereDocumentView(`command -v rm -rf ${runtime}`);
  const source = { provider: 'claude', tool: 'shell', cwd: ordinary };
  assert.equal(decideShellHookPayload(view, ordinary, source, 0, true, false).decision, 'deny');
  assert.equal(decideShellHookPayload(view, ordinary, source, 0, false, true).decision, 'allow');
});

test('proven inquiries cannot become preview/SSH execution or mutate later positional arguments', () => {
  verify(['command -v pnpm preview:process stop --port 3004', 'command -v ssh'], 'allow');
  verify([`set -- rm -rf ${runtime}; command -v set -- printf; "$@"`], 'deny');
  verify([`set -- printf safe; command -v set -- rm -rf ${runtime}; "$@"`], 'allow');
});
