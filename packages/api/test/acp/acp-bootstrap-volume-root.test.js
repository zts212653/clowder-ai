import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join, parse } from 'node:path';
import { describe, it } from 'node:test';
import { ensureWindowsAcpBootstrapDirectories } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-windows-directory.js';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function inspect(path) {
  const script = `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $a = Get-Acl -LiteralPath $p
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $danger = 0
    foreach ($r in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band 2) -eq 0 -and
          $trusted -notcontains $r.IdentityReference.Value) { $danger = $danger -bor ([int]$r.FileSystemRights -band 0xD0040) }
    }
    @{ sddl=$a.Sddl; protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
       user=$sid; danger=$danger; format=([IO.DriveInfo]::new([IO.Path]::GetPathRoot($p))).DriveFormat } | ConvertTo-Json -Compress
  `;
  return JSON.parse(
    execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        input: JSON.stringify(path),
        encoding: 'utf8',
        windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
      },
    ),
  );
}

describe('native Windows volume-root bootstrap (#1653)', { skip: process.platform !== 'win32' }, () => {
  it('creates and reopens a private root below a real data volume with DELETE-only broad grants', (t) => {
    const volume = process.env.ACP_BOOTSTRAP_TEST_VOLUME;
    if (!volume) return t.skip('set ACP_BOOTSTRAP_TEST_VOLUME to a disposable-directory-capable data volume');
    assert.equal(parse(volume).root, volume);
    assert.notEqual(volume.toLowerCase(), `${process.env.SystemDrive}\\`.toLowerCase());
    const before = inspect(volume);
    assert.equal(before.format, 'NTFS');
    assert.equal(before.danger, 0x10000, 'fixture volume must exercise the actual DELETE-only rejection');
    const root = join(volume, `.clowder-acp-1653-test-${randomUUID()}`);
    const cwd = join(root, 'cwd');
    try {
      ensureWindowsAcpBootstrapDirectories(root, cwd, { allowVolumeRootDelete: true });
      assert.equal(inspect(root).owner, before.user);
      assert.equal(inspect(root).protected, true);
      assert.equal(inspect(root).danger, 0);
      const privateSddl = inspect(root).sddl;
      ensureWindowsAcpBootstrapDirectories(root, cwd, { allowVolumeRootDelete: true });
      assert.equal(inspect(root).sddl, privateSddl);
      const actual = execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(require("node:fs").realpathSync(process.cwd()))'],
        { cwd, encoding: 'utf8', windowsHide: true },
      );
      assert.equal(actual, realpathSync(cwd));
    } finally {
      // Exact UUID path created by this test; never delete or change the volume itself.
      assert.equal(parse(root).dir, volume);
      assert.match(parse(root).base, /^\.clowder-acp-1653-test-[0-9a-f-]{36}$/);
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      assert.equal(inspect(volume).sddl, before.sddl, 'the existing volume ACL must remain byte-for-byte unchanged');
    }
  });

  it('keeps the same data volume rejected for an unclassified ACP startup', (t) => {
    const volume = process.env.ACP_BOOTSTRAP_TEST_VOLUME;
    if (!volume) return t.skip('requires an explicitly selected data volume');
    const root = join(volume, `.clowder-acp-1653-test-${randomUUID()}`);
    assert.throws(() => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd')), /unsafe directory replacement/);
    assert.equal(existsSync(root), false);
  });
});
