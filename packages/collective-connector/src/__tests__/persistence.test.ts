import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConnectorPersistence } from '../persistence.js';

const run = promisify(execFile);
const windows = process.platform === 'win32';

async function fixture(name = 'private'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'connector-permissions-')), name);
}

async function permissionSnapshot(path: string): Promise<string | number> {
  if (!windows) return (await lstat(path)).mode & 0o777;
  const script = `
    $ErrorActionPreference = 'Stop'
    if ([System.IO.Directory]::Exists($env:CONNECTOR_TEST_PATH)) {
      $acl = [System.IO.Directory]::GetAccessControl($env:CONNECTOR_TEST_PATH)
    } else { $acl = [System.IO.File]::GetAccessControl($env:CONNECTOR_TEST_PATH) }
    $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)
  `;
  const { stdout } = await run(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, env: { ...process.env, CONNECTOR_TEST_PATH: path } },
  );
  return stdout.trim();
}

async function windowsAcl(path: string, publicAccess: boolean): Promise<void> {
  const script = `
    $ErrorActionPreference = 'Stop'
    $path = $env:CONNECTOR_TEST_PATH
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $directory = [System.IO.Directory]::Exists($path)
    if ($directory) {
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $acl = [System.Security.AccessControl.FileSecurity]::new()
      $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid, 'FullControl', $inherit, 'None', 'Allow'))
    if ($env:CONNECTOR_TEST_PUBLIC -eq '1') {
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', $inherit, 'None', 'Allow'))
    }
    if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
    else { [System.IO.File]::SetAccessControl($path, $acl) }
  `;
  await run(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      env: { ...process.env, CONNECTOR_TEST_PATH: path, CONNECTOR_TEST_PUBLIC: publicAccess ? '1' : '0' },
    },
  );
}

async function setPrivate(path: string): Promise<void> {
  if (windows) await windowsAcl(path, false);
  else await chmod(path, (await lstat(path)).isDirectory() ? 0o700 : 0o600);
}

async function setPublic(path: string): Promise<void> {
  if (windows) await windowsAcl(path, true);
  else await chmod(path, (await lstat(path)).isDirectory() ? 0o755 : 0o644);
}

describe('Connector credential persistence permissions', { timeout: 30_000 }, () => {
  it('creates private state, commits a transaction, and reopens it', async () => {
    const directory = await fixture();
    const persistence = await ConnectorPersistence.open(directory);
    await persistence.transaction((draft) => {
      draft.legacyConnections.push({
        connectionId: 'legacy-test',
        reason: 'identity_rebind_required',
        migratedAt: new Date(0).toISOString(),
        state: {},
      });
    });
    const reopened = await ConnectorPersistence.open(directory);
    expect(reopened.snapshot().legacyConnections).toHaveLength(1);
    expect(JSON.parse(await readFile(persistence.filePath, 'utf8'))).toEqual(reopened.snapshot());
    if (!windows) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(persistence.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a directory granting other users access without changing its ACL', async () => {
    const directory = await fixture();
    await mkdir(directory);
    await setPublic(directory);
    const before = await permissionSnapshot(directory);
    await expect(ConnectorPersistence.open(directory)).rejects.toThrow(/private|permission/i);
    expect(await permissionSnapshot(directory)).toEqual(before);
    await expect(lstat(join(directory, 'collective-connector.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('can open an existing private directory on the native platform', async () => {
    const directory = await fixture();
    await mkdir(directory);
    await setPrivate(directory);
    await expect(ConnectorPersistence.open(directory)).resolves.toBeDefined();
  });

  it('rejects a credential file granting other users access on reopen', async () => {
    const directory = await fixture();
    const persistence = await ConnectorPersistence.open(directory);
    const before = await readFile(persistence.filePath, 'utf8');
    await setPublic(persistence.filePath);
    await expect(ConnectorPersistence.open(directory)).rejects.toThrow(/private|permission/i);
    expect(await readFile(persistence.filePath, 'utf8')).toBe(before);
  });

  it('rejects directory links instead of protecting or writing through them', async () => {
    const directory = await fixture();
    const target = await fixture();
    await mkdir(target);
    await setPrivate(target);
    await symlink(target, directory, windows ? 'junction' : 'dir');
    await expect(ConnectorPersistence.open(directory)).rejects.toThrow(/private|regular directory|reparse/i);
    await expect(lstat(join(target, 'collective-connector.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a later transaction when directory privacy has been lost', async () => {
    const directory = await fixture();
    const persistence = await ConnectorPersistence.open(directory);
    const before = await readFile(persistence.filePath, 'utf8');
    await setPublic(directory);
    await expect(persistence.transaction(() => undefined)).rejects.toThrow(/private|permission/i);
    expect(await readFile(persistence.filePath, 'utf8')).toBe(before);
  });

  it('treats quoted and shell-shaped directory names as literal path data', async () => {
    const directory = await fixture("private 'quoted' $(literal)");
    const persistence = await ConnectorPersistence.open(directory);
    expect(persistence.filePath).toBe(join(directory, 'collective-connector.json'));
    expect((await ConnectorPersistence.open(directory)).snapshot()).toEqual(persistence.snapshot());
  });
});
