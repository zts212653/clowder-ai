import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ensureWindowsAcpBootstrapDirectories } from '../../src/domains/cats/services/agents/providers/acp/acp-bootstrap-windows-directory.ts';

test(
  'trusted-host opt-in skips only ancestor trust and never repairs existing ACLs',
  { skip: process.platform !== 'win32' },
  () => {
    const parent = mkdtempSync(join(tmpdir(), 'acp-compat-native-'));
    const root = join(parent, 'private');
    const cwd = join(root, 'cwd');
    const original = process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
    const ps = (script: string, path: string) =>
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(`$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); ${script}`, 'utf16le').toString(
            'base64',
          ),
        ],
        { input: path, encoding: 'utf8', windowsHide: true },
      );
    try {
      delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
      ps(
        `$acl=[Security.AccessControl.DirectorySecurity]::new();
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
        $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Modify','None','None','Allow'));
        [IO.Directory]::SetAccessControl($p,$acl)`,
        parent,
      );
      const acl = (path: string) => ps('[IO.Directory]::GetAccessControl($p).Sddl', path).trim();
      const before = acl(parent);
      assert.throws(
        () => ensureWindowsAcpBootstrapDirectories(root, cwd),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PARENT_REPLACEMENT',
      );
      process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
      ensureWindowsAcpBootstrapDirectories(root, cwd);
      assert.equal(acl(parent), before, 'compatibility must leave the broad ancestor ACL untouched');
      assert.equal(existsSync(cwd), true);
      assert.match(ps('[IO.Directory]::GetAccessControl($p).AreAccessRulesProtected', root), /True/);
      assert.doesNotMatch(acl(root), /AU|S-1-5-11/);
      delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
      assert.throws(() => ensureWindowsAcpBootstrapDirectories(root, cwd), /unsafe directory replacement/);
      process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
      ps(
        `$acl=[IO.Directory]::GetAccessControl($p);
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Modify','None','None','Allow'));
        [IO.Directory]::SetAccessControl($p,$acl)`,
        root,
      );
      assert.throws(() => ensureWindowsAcpBootstrapDirectories(root, cwd), /unsafe Allow ACL/);
      const physical = join(parent, 'physical');
      const alias = join(parent, 'junction');
      mkdirSync(physical);
      symlinkSync(physical, alias, 'junction');
      assert.throws(
        () => ensureWindowsAcpBootstrapDirectories(join(alias, 'private'), join(alias, 'private', 'cwd')),
        /symlink or reparse point/,
      );
      assert.equal(existsSync(join(physical, 'private')), false);
    } finally {
      if (original === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
      else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = original;
      assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
      assert.match(basename(parent), /^acp-compat-native-/);
      rmSync(parent, { recursive: true });
    }
  },
);

test(
  'a missing Unicode ancestor is reported as a readable structured rejection',
  { skip: process.platform !== 'win32' },
  () => {
    const missing = join(tmpdir(), `不存在-${randomUUID()}`);
    assert.throws(
      () => ensureWindowsAcpBootstrapDirectories(join(missing, 'private'), join(missing, 'private', 'cwd')),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /directory does not exist/);
        assert.ok('path' in error && typeof error.path === 'string');
        assert.equal(basename(error.path), basename(missing));
        // WinPS may expand a runner's short-name/case spelling in DirectoryInfo.
        // Compare the real existing parent and the exact missing Unicode leaf.
        assert.equal(
          realpathSync.native(dirname(error.path)).toLowerCase(),
          realpathSync.native(dirname(missing)).toLowerCase(),
        );
        assert.ok(error.message.includes(error.path), 'the readable error must include the full reported path');
        return true;
      },
    );
    assert.equal(existsSync(missing), false);
  },
);

test(
  'strict admission rejects SUBST roots that hide the physical ancestor chain',
  { skip: process.platform !== 'win32' },
  () => {
    const parent = mkdtempSync(join(tmpdir(), 'acp-strict-alias-'));
    const drive = ['Z:', 'Y:', 'X:', 'W:'].find((candidate) => !existsSync(`${candidate}\\`));
    assert.ok(drive, 'a free drive letter is required for the disposable SUBST fixture');
    let mapped = false;
    const original = process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
    try {
      const script = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
      $acl=[Security.AccessControl.DirectorySecurity]::new(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
      [IO.Directory]::SetAccessControl($p,$acl)`;
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { input: parent, windowsHide: true },
      );
      execFileSync('subst.exe', [drive, parent], { windowsHide: true });
      mapped = true;
      const root = `${drive}\\bootstrap`;
      for (const mode of [undefined, '1']) {
        if (mode === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
        else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = mode;
        assert.throws(
          () => ensureWindowsAcpBootstrapDirectories(root, join(root, 'cwd')),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PARENT_VOLUME',
        );
      }
      assert.equal(
        existsSync(join(parent, 'bootstrap')),
        false,
        'alias must reject before creating any bootstrap directory',
      );
    } finally {
      if (original === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
      else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = original;
      if (mapped) {
        const mapping = execFileSync('subst.exe', { encoding: 'utf8', windowsHide: true });
        assert.ok(
          mapping
            .split(/\r?\n/)
            .some(
              (line) =>
                line.toLowerCase().startsWith(drive!.toLowerCase()) &&
                line.toLowerCase().endsWith(`=> ${parent.toLowerCase()}`),
            ),
          'only remove the mapping created by this test',
        );
        execFileSync('subst.exe', [drive!, '/D'], { windowsHide: true });
      }
      assert.match(parent, /acp-strict-alias-[^\\/]+$/);
      rmSync(parent, { recursive: true });
    }
  },
);
