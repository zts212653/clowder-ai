import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

// Review864: every executed SSH carrier must retain local admission even when
// it cannot receive the narrow remote-only proof. These strings never execute.
function fixture(t, configuration = '') {
  const root = mkdtempSync(join(tmpdir(), 'f306-ssh-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  writeFileSync(config, configuration);
  const options = {
    selfHost: () => ({
      confidence: 'current',
      facet: { runtime: { worktree: root, apiPid: 4242, apiPort: 3002 } },
    }),
    observeHost: () => ({}),
    sshScope: { configFiles: [config], localAddresses: [] },
  };
  return (command, expected = 'deny') => {
    for (const tool_name of ['Bash', 'exec_command']) {
      const result = decideNativeHookPayload(
        {
          tool_name,
          cwd: root,
          tool_input: { command },
          ...(tool_name === 'exec_command' ? { turn_id: 'ssh-admission', tool_use_id: 'ssh-check' } : {}),
        },
        options,
      );
      assert.equal(result.decision, expected, `${tool_name}: ${command}\n${JSON.stringify(result)}`);
    }
  };
}

test('unknown and target-changing SSH options never discard a quoted local stop target', (t) => {
  const check = fixture(t);
  for (const option of [
    '-o HostName=127.0.0.1',
    '-o UnmodelledOption=yes',
    '-F /tmp/ssh-config-not-executed',
    '-J localhost',
    '-L 3002:localhost:3004',
    '-Q cipher',
    '-Z',
  ])
    check(`ssh ${option} root@203.0.113.8 'kill -TERM 4242'`);
});

test('SSH compression, absent remote argv, and stdin cannot bypass local configuration', (t) => {
  const check = fixture(t, 'Host *\n ProxyCommand kill -TERM 4242\n');
  for (const command of [
    'ssh -C root@203.0.113.8 true',
    'ssh root@203.0.113.8',
    "ssh root@203.0.113.8 <<'REMOTE'\ntrue\nREMOTE\n",
    'ssh root@203.0.113.8 bash -s <<REMOTE\ntrue\nREMOTE\n',
    'ssh root@203.0.113.8 bash -s <<A <<B\ntrue\nA\ntrue\nB\n',
  ])
    check(command);
});

test('SSH options after the destination are not remote command data', (t) => {
  const check = fixture(t);
  for (const tail of [
    "-o 'ProxyCommand=kill -TERM 4242' true",
    "-o HostName=127.0.0.1 'kill -TERM 4242'",
    '-F /tmp/ssh-config-not-executed true',
    '-J localhost true',
  ])
    check(`ssh root@203.0.113.8 ${tail}`);
});

test('unquoted and incomplete heredocs retain explicit local SSH code options', (t) => {
  const check = fixture(t);
  for (const suffix of ['<<REMOTE\ntrue\nREMOTE\n', '<<REMOTE\ntrue\n'])
    check(`ssh -o 'ProxyCommand=kill -TERM 4242' root@203.0.113.8 bash -s ${suffix}`);
});

test('wrappers, compound commands, substitutions, and inline shells cannot bypass SSH admission', (t) => {
  const check = fixture(t, 'Host *\n ProxyCommand kill -TERM 4242\n');
  const ssh = 'ssh -C root@203.0.113.8 true';
  for (const command of [
    `true && ${ssh}`,
    `${ssh} | cat`,
    `env ${ssh}`,
    `command ${ssh}`,
    `bash -c '${ssh}'`,
    `printf '%s' "$(${ssh})"`,
    'true && ssh -o "ProxyCommand=kill -TERM 4242" root@203.0.113.8 true',
    'env ssh -o "ProxyCommand=kill -TERM 4242" root@203.0.113.8 true',
  ])
    check(command);
});

test('nonliteral SSH words do not skip configuration or local executor checks', (t) => {
  const check = fixture(t, 'Host *\n ProxyCommand kill -TERM 4242\n');
  for (const command of [
    'ssh -i ~/.ssh/identity root@203.0.113.8 true',
    'ssh root@$REMOTE_HOST true',
    'ssh root@203.0.113.8 "$(printf true)"',
  ])
    check(command);
});

test('SSH text consumed as data does not trigger execution admission', (t) => {
  const check = fixture(t, 'Host *\n ProxyCommand kill -TERM 4242\n');
  check("printf '%s' 'ssh -C root@203.0.113.8 true'", 'allow');
  check("cat <<'NOTE'\nssh -C root@203.0.113.8 true\nNOTE\n", 'allow');
});
