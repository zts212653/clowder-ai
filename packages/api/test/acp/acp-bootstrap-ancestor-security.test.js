import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureWindowsAcpBootstrapDirectories } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-windows-directory.js';

const windows = { skip: process.platform !== 'win32' };
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function acl(path, operation = '') {
  const script = `
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $path=[Console]::In.ReadToEnd() | ConvertFrom-Json
    $acl=Get-Acl -LiteralPath $path
    ${operation}
    (Get-Acl -LiteralPath $path).Sddl
  `;
  return execFileSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      input: JSON.stringify(path),
      encoding: 'utf8',
      windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
    },
  ).trim();
}
function fixture(run) {
  const parent = mkdtempSync(join(tmpdir(), 'acp-ancestor-security-'));
  try {
    return run(parent, join(parent, 'private'));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

for (const rights of ['Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership', 'FullControl']) {
  test(`volume policy still rejects ${rights} on an ordinary ancestor`, windows, () =>
    fixture((parent, root) => {
      const before = acl(
        parent,
        `
      $rule=[Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-11'), '${rights}', 'Allow')
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl
    `,
      );
      assert.throws(
        () => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd'), { allowVolumeRootDelete: true }),
        (error) => error.code === 'PARENT_REPLACEMENT',
      );
      assert.equal(existsSync(root), false);
      assert.equal(acl(parent), before, 'existing ancestor ACL must not be repaired');
    }),
  );
}

for (const callback of [false, true]) {
  test(`raw ${callback ? 'callback' : 'GenericAll'} ACE cannot evade the parent check`, windows, () =>
    fixture((parent, root) => {
      const before = acl(
        parent,
        `
      $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
      $ace=[Security.AccessControl.CommonAce]::new(0,0,268435456,
        [Security.Principal.SecurityIdentifier]::new('S-1-5-11'),$${callback},$null)
      $raw.DiscretionaryAcl.InsertAce(0,$ace)
      $bytes=[byte[]]::new($raw.BinaryLength); $raw.GetBinaryForm($bytes,0)
      $acl.SetSecurityDescriptorBinaryForm($bytes); Set-Acl -LiteralPath $path -AclObject $acl
    `,
      );
      assert.throws(
        () => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd'), { allowVolumeRootDelete: true }),
        (error) => ['PARENT_REPLACEMENT', 'UNSUPPORTED_ACL'].includes(error.code),
      );
      assert.equal(existsSync(root), false);
      assert.equal(acl(parent), before);
    }),
  );
}

test('a SUBST drive root is not a native volume root', windows, () =>
  fixture((parent) => {
    const letter = ['Z', 'Y', 'X', 'W'].find((value) => !existsSync(`${value}:\\`));
    assert.ok(letter, 'a free drive letter is required for the temporary SUBST fixture');
    const subst = join(process.env.SystemRoot, 'System32', 'subst.exe');
    execFileSync(subst, [`${letter}:`, parent], { windowsHide: true });
    try {
      const root = `${letter}:\\private`;
      assert.throws(
        () => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd'), { allowVolumeRootDelete: true }),
        (error) => error.code === 'PARENT_VOLUME',
      );
      assert.equal(existsSync(join(parent, 'private')), false);
    } finally {
      execFileSync(subst, [`${letter}:`, '/D'], { windowsHide: true });
    }
  }),
);

test('an existing unsafe private root is rejected before an ancestor failure can relocate it', windows, () =>
  fixture((parent, root) => {
    mkdirSync(root);
    acl(
      parent,
      `
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Delete','Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
  `,
    );
    // Windows may update a child's auto-inherited flag while changing its
    // parent. Snapshot after fixture preparation, before the verifier runs.
    const before = acl(root);
    assert.throws(
      () => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd'), { allowVolumeRootDelete: true }),
      (error) =>
        error.code === 'DIRECTORY_OWNER' ||
        (error.code === 'VERIFICATION_UNAVAILABLE' && /protected private DACL/.test(error.message)),
    );
    assert.equal(acl(root), before);
    assert.equal(existsSync(join(root, 'cwd')), false);
  }),
);
