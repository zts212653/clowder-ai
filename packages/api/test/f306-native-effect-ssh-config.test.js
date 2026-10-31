import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sshConfigurationScope } from '../../../scripts/lib/ssh-configuration-scope.mjs';
import { systemSshRunnerInputs } from './helpers/system-ssh-runner-inputs.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-config-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an included symlinked crypto file is a read input; an included ProxyCommand remains local', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    source = join(root, 'source'),
    link = join(root, 'crypto');
  writeFileSync(config, `Host *\n Include ${link}\n`);
  writeFileSync(source, 'Ciphers aes256-gcm@openssh.com\n');
  symlinkSync(source, link);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, true);
  writeFileSync(source, 'ProxyCommand touch /tmp/not-executed\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
});

test('unknown includes, cycles, and non-regular files cannot be silently treated as empty configuration', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  for (const content of [`Include ${config}\n`, 'Include %h/missing\n', 'Match exec true\n']) {
    writeFileSync(config, content);
    assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
  }
  const fifo = join(root, 'fifo');
  execFileSync('mkfifo', [fifo]);
  assert.equal(sshConfigurationScope('203.0.113.8', [fifo]).complete, false, 'must not block opening FIFO');
});

test('Host negation and a literal destination reject local relocation while preserving unrelated aliases', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  writeFileSync(config, 'Host * !203.0.113.8\n ProxyCommand false\nHost 203.0.113.?\n Port 2222\n');
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 2222 });
  writeFileSync(config, 'Host 203.0.113.*\n HostName 127.0.0.1\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
});

test('disabling values belong to each SSH option; a command named no or false is still local execution', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  for (const directive of ['ProxyCommand no', 'KnownHostsCommand false', 'LocalCommand no']) {
    writeFileSync(config, `Host *\n ${directive}\n`);
    assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false, directive);
  }
  writeFileSync(config, 'Host *\n ProxyCommand none\n PermitLocalCommand no\n ControlMaster no\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, true);
});

test('an Include Host block cannot disable local admission in its active parent', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    included = join(root, 'included');
  writeFileSync(included, 'Host unrelated.example\n Port 2266\n');
  writeFileSync(config, `Host *\n Include ${included}\n ProxyCommand kill -TERM 4242\n`);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
  writeFileSync(config, `Host *\n Include ${included}\n Port 2255\n`);
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 2255 });
});

test('unrelated systemd SSH transport patterns are data, while matching proxy blocks stay denied', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    transport = join(root, '20-systemd-ssh-proxy.conf');
  // systemd's distributed ssh_config fragment: slash and percent are literal
  // Host pattern data, not shell syntax or percent expansion in this directive.
  writeFileSync(
    transport,
    [
      'Host .host machine/.host',
      ' ProxyCommand /usr/lib/systemd/systemd-ssh-proxy unix/run/ssh-unix-local/socket %p',
      'Host unix/* unix%* vsock/* vsock%* vsock-mux/* vsock-mux%* machine/* machine%*',
      ' User root',
      ' ProxyCommand /usr/lib/systemd/systemd-ssh-proxy %h %p',
      ' ProxyUseFdpass yes',
      ' CheckHostIP no',
    ].join('\n'),
  );
  writeFileSync(config, `Include ${transport}\nHost *\n Port 22\n`);
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 22 });
  for (const host of [
    '.host',
    'machine/.host',
    'unix/run/ssh/socket',
    'unix%run%ssh%socket',
    'vsock/7:22',
    'machine/test',
  ])
    assert.equal(sshConfigurationScope(host, [config]).complete, false, host);
  writeFileSync(config, `Include ${transport}\nHost *\n ProxyCommand kill -TERM 4242\n`);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false, 'active proxy remains local');
});

test('runner diagnostics capture only bounded system inputs and never follow an extra Include', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'ssh_config.d'));
  writeFileSync(join(root, 'ssh_config'), `Include ${root}/ssh_config.d/*.conf\n`);
  writeFileSync(join(root, 'ssh_config.d', '20-local.conf'), 'Host unix/* unix%*\n ProxyCommand false\n');
  const result = systemSshRunnerInputs(root);
  assert.deepEqual(result.scope, { complete: true, port: 22 });
  assert.equal(result.files.length, 2);
  writeFileSync(join(root, 'ssh_config'), 'Include ~/.ssh/config\n');
  assert.equal(systemSshRunnerInputs(root).scope.reason, 'diagnostic_include_out_of_scope');
});
