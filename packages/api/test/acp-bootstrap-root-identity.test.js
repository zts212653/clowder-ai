import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAcpBootstrapRootIdentity } from '../dist/domains/plugin/manager/acp-bootstrap-root-identity.js';

test(
  'native Windows directory identities recognize aliases and replacement, rejecting new reparse paths',
  { skip: process.platform !== 'win32' },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), 'acp-native-identity-'));
    const root = join(parent, 'Long Directory With Spaces');
    mkdirSync(root);
    const original = readAcpBootstrapRootIdentity(root);
    assert.ok(original);
    assert.equal(readAcpBootstrapRootIdentity(root.toUpperCase()), original);
    const ps = `$p=[Console]::In.ReadToEnd() | ConvertFrom-Json; [Console]::Out.Write((New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath)`;
    const short = execFileSync(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { input: JSON.stringify(root), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    assert.equal(readAcpBootstrapRootIdentity(short), original);
    t.diagnostic(
      short.includes('~') ? 'native 8.3 alias verified' : 'filesystem returned the long name; 8.3 alias unavailable',
    );
    renameSync(root, `${root}-retained`);
    mkdirSync(root);
    assert.notEqual(readAcpBootstrapRootIdentity(root), original);
    assert.equal(readAcpBootstrapRootIdentity(join(parent, 'missing')), undefined);
    const link = join(parent, 'junction');
    symlinkSync(root, link, 'junction');
    assert.throws(() => readAcpBootstrapRootIdentity(link), /reparse point/);
    assert.equal(readAcpBootstrapRootIdentity(link, true), readAcpBootstrapRootIdentity(root));
  },
);
