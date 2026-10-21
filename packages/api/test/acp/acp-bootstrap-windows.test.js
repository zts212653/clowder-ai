import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { resolveAcpBootstrapCwd } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js';
import { ensureWindowsAcpBootstrapDirectories } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-windows-directory.js';

const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
function inspectOrChangeAcl(path, operation = '') {
  // Independent native oracle; only fixture paths are passed on stdin.
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    $path = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $acl = Get-Acl -LiteralPath $path
    ${operation}
    $acl = Get-Acl -LiteralPath $path
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
    $result = @{
      owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
      currentUser = $sid.Value
      protected = $acl.AreAccessRulesProtected
      sddl = $acl.Sddl
      elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
      rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights }
      })
    }
    [Console]::Out.Write(($result | ConvertTo-Json -Depth 4 -Compress))
  `;
  return JSON.parse(
    execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        // Keep the independent Get-Acl/Set-Acl oracle on Windows PowerShell
        // modules even when the native runner's parent shell is pwsh.
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')),
        input: JSON.stringify(path),
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ),
  );
}

describe('Windows PowerShell child environment', () => {
  for (const oracle of [false, true]) {
    it(`${oracle ? 'ACL fixture' : 'production verifier'} excludes inherited PowerShell 7 module paths`, () => {
      const saved = process.env.PSModulePath;
      process.env.PSModulePath = 'fixture-powershell-7-modules';
      let childEnvironment;
      const stub = mock.method(childProcess, 'execFileSync', (_command, _args, options) => {
        childEnvironment = options.env;
        return oracle ? '{}' : 'acp-private-directory-v1';
      });
      syncBuiltinESMExports();
      try {
        if (oracle) inspectOrChangeAcl(join(tmpdir(), 'fixture-acl'));
        else ensureWindowsAcpBootstrapDirectories(tmpdir(), join(tmpdir(), 'fixture-cwd'));
        assert.ok(childEnvironment, 'Windows PowerShell needs an explicit child environment');
        assert.equal(
          Object.keys(childEnvironment).some((key) => key.toUpperCase() === 'PSMODULEPATH'),
          false,
        );
        assert.equal(
          Object.entries(childEnvironment).find(([key]) => key.toUpperCase() === 'PATH')?.[1],
          process.env.PATH,
        );
        assert.equal(process.env.PSModulePath, 'fixture-powershell-7-modules');
      } finally {
        stub.mock.restore();
        syncBuiltinESMExports();
        if (saved === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = saved;
      }
    });
  }
});

describe('Windows ACL verifier failure reporting', () => {
  for (const [label, stderr] of [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', ' \r\n'],
    ['empty buffer', Buffer.alloc(0)],
  ]) {
    it(`reports unavailable verification for ${label} stderr`, () => {
      const stub = mock.method(childProcess, 'execFileSync', () => {
        throw Object.assign(new Error('spawn failed'), { stderr });
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => ensureWindowsAcpBootstrapDirectories(tmpdir(), join(tmpdir(), 'fixture-cwd')), {
          code: 'VERIFICATION_UNAVAILABLE',
          message: 'Windows ACP bootstrap privacy check failed: verification unavailable',
        });
      } finally {
        stub.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
});

describe('native Windows ACP bootstrap privacy', { skip: process.platform !== 'win32' }, () => {
  const fixtures = new Set();
  const fixture = () => {
    const parent = mkdtempSync(join(tmpdir(), 'acp-win-private-test-'));
    fixtures.add(parent);
    return { parent, root: join(parent, 'bootstrap'), project: join(parent, 'project') };
  };
  afterEach(() => {
    // Only roots created by this test process; never enumerate a runtime root.
    for (const path of fixtures) rmSync(path, { recursive: true, force: true });
    fixtures.clear();
  });

  it('creates private root/cwd and reopens them without changing the DACL', () => {
    const { root, project } = fixture();
    const cwd = resolveAcpBootstrapCwd(project, 'native', root);
    const before = [root, cwd].map((path) => inspectOrChangeAcl(path));
    for (const acl of before) {
      assert.equal(acl.owner, acl.currentUser);
      assert.equal(acl.protected, true);
      assert.ok(
        acl.rules.some((rule) => rule.sid === acl.currentUser && rule.allow && (rule.rights & 0x1f01ff) === 0x1f01ff),
      );
      assert.ok(
        acl.rules.every((rule) => !rule.allow || [acl.currentUser, 'S-1-5-18', 'S-1-5-32-544'].includes(rule.sid)),
      );
    }
    assert.equal(resolveAcpBootstrapCwd(project, 'native', root), cwd);
    assert.deepEqual(
      [root, cwd].map((path) => inspectOrChangeAcl(path).sddl),
      before.map((acl) => acl.sddl),
    );
    // Receipt records the actual token; an elevated runner is not non-admin proof.
    console.log(`ACP native token elevated=${before[0].elevated}`);
  });

  it('treats quotes, PowerShell syntax and Unicode in paths as data', () => {
    const { parent, project } = fixture();
    const root = join(parent, "bootstrap ' $(whoami) 中文");
    assert.ok(existsSync(resolveAcpBootstrapCwd(project, 'quoted', root)));
    assert.equal(inspectOrChangeAcl(root).protected, true);
  });

  it('starts a native process from the private cwd and starts again after reopening', () => {
    const { root, project } = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      const cwd = resolveAcpBootstrapCwd(project, 'native-spawn', root);
      const actual = execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(require("node:fs").realpathSync(process.cwd()))'],
        {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        },
      );
      assert.equal(actual, realpathSync(cwd));
    }
  });

  for (const location of ['root', 'cwd']) {
    for (const sid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']) {
      it(`rejects ${sid} Allow on an existing ${location} without repairing it`, () => {
        const { root, project } = fixture();
        const cwd = resolveAcpBootstrapCwd(project, 'unsafe-acl', root);
        const path = location === 'root' ? root : cwd;
        const before = inspectOrChangeAcl(
          path,
          `
          $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new('${sid}'), '${sid === 'S-1-5-11' ? 'Modify' : 'ReadAndExecute'}', 'Allow')
          $acl.AddAccessRule($rule)
          Set-Acl -LiteralPath $path -AclObject $acl
        `,
        );
        assert.throws(() => resolveAcpBootstrapCwd(project, 'unsafe-acl', root), /unsafe Allow ACL/);
        assert.equal(inspectOrChangeAcl(path).sddl, before.sddl, 'unsafe existing ACL must remain untouched');
      });
    }
  }

  it('rejects inheritance-enabled existing roots instead of silently protecting them', () => {
    const { root, project } = fixture();
    resolveAcpBootstrapCwd(project, 'inherited', root);
    const before = inspectOrChangeAcl(
      root,
      '$acl.SetAccessRuleProtection($false, $true); Set-Acl -LiteralPath $path -AclObject $acl',
    );
    assert.throws(() => resolveAcpBootstrapCwd(project, 'inherited', root), /protected private DACL/);
    assert.equal(inspectOrChangeAcl(root).sddl, before.sddl);
  });

  it('rejects an existing regular file without deleting or replacing it', () => {
    const { root, project } = fixture();
    writeFileSync(root, 'keep me');
    assert.throws(() => resolveAcpBootstrapCwd(project, 'file', root), /privacy check failed/);
    assert.ok(existsSync(root));
  });

  for (const location of ['root', 'cwd', 'ancestor']) {
    it(`rejects a junction at the ${location} without touching its target`, () => {
      const { root, project } = fixture();
      const { parent: target } = fixture();
      writeFileSync(join(target, 'sentinel'), 'keep me');
      let bootstrapRoot = root;
      const cwd = resolveAcpBootstrapCwd(project, 'junction', root);
      const path = location === 'cwd' ? cwd : root;
      rmSync(path, { recursive: true });
      symlinkSync(target, path, 'junction');
      if (location === 'ancestor') bootstrapRoot = join(path, 'child');
      assert.throws(() => resolveAcpBootstrapCwd(project, 'junction', bootstrapRoot), /reparse point/);
      assert.ok(existsSync(join(target, 'sentinel')));
      assert.equal(existsSync(join(target, 'child')), false);
    });
  }

  it('rejects unsafe parent delete-child grants before creating a private root', () => {
    const { parent, root, project } = fixture();
    inspectOrChangeAcl(
      parent,
      `
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'DeleteSubdirectoriesAndFiles', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $path -AclObject $acl
    `,
    );
    assert.throws(() => resolveAcpBootstrapCwd(project, 'unsafe-parent', root), /unsafe directory replacement/);
    assert.equal(existsSync(root), false);
  });

  it('rejects a foreign owner without taking ownership', (t) => {
    const { root, project } = fixture();
    resolveAcpBootstrapCwd(project, 'foreign-owner', root);
    if (!inspectOrChangeAcl(root).elevated) {
      t.skip('setting a foreign owner requires an elevated fixture creator; standard-user coverage is separate');
      return;
    }
    const before = inspectOrChangeAcl(
      root,
      `
      $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
      Set-Acl -LiteralPath $path -AclObject $acl
    `,
    );
    assert.throws(() => resolveAcpBootstrapCwd(project, 'foreign-owner', root), /untrusted owner/);
    assert.equal(inspectOrChangeAcl(root).owner, before.owner);
  });

  it('fails closed when native ACL verification cannot run', () => {
    const { parent, root, project } = fixture();
    const saved = process.env.SystemRoot;
    try {
      process.env.SystemRoot = join(parent, 'missing-Windows');
      assert.throws(() => resolveAcpBootstrapCwd(project, 'no-checker', root), /privacy check failed/);
      assert.equal(existsSync(root), false);
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
  });

  it('revalidates a pooled cold start after the root ACL changes', async () => {
    const { createAcpServiceForConfig } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
    );
    const { root, project } = fixture();
    const poolRegistry = new Map();
    const id = 'native-reopen';
    try {
      assert.ok(
        await createAcpServiceForConfig({
          projectRoot: project,
          bootstrapRoot: root,
          profileId: id,
          effectiveModel: 'test-model',
          config: {
            id,
            name: id,
            displayName: id,
            color: { primary: '#111111', secondary: '#eeeeee' },
            avatar: '/fixture.png',
            mentionPatterns: ['@native-reopen'],
            roleDescription: 'fixture',
            clientId: 'acp',
            defaultModel: 'test-model',
            mcpSupport: false,
          },
          acpConfig: { command: 'never-spawn', startupArgs: [] },
          poolRegistry,
          log: { info() {}, warn() {} },
        }),
      );
      const pool = poolRegistry.get(id);
      assert.ok(pool.clientFactory());
      inspectOrChangeAcl(
        root,
        `
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
          [System.Security.Principal.SecurityIdentifier]::new('S-1-5-11'), 'Modify', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $path -AclObject $acl
      `,
      );
      assert.throws(() => pool.clientFactory(), /unsafe Allow ACL/);
      assert.equal(poolRegistry.get(id), pool, 'validation failure must not force-close the active pool');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
    }
  });
});
