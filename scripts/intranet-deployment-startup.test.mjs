import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const policyURL = pathToFileURL(join(root, 'packages/api/dist/config/acp-deployment-policy.js')).href;
const bootstrapURL = pathToFileURL(join(root, 'packages/api/dist/config/trusted-host-compatibility.js')).href;
const auditURL = pathToFileURL(join(root, 'packages/api/dist/config/acp-bootstrap-config-audit-policy.js')).href;
const policyKeys = [
  'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
  'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
  'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
];
function policyChild(env = {}) {
  const clean = { ...process.env };
  for (const key of policyKeys) delete clean[key];
  const code = `import { initializeAcpDeploymentPolicy } from ${JSON.stringify(policyURL)}; import {isTrustedHostCompatibilityEnabled} from ${JSON.stringify(bootstrapURL)}; import {allowsAcpBootstrapConfigAuditWarning} from ${JSON.stringify(auditURL)}; const logs=[]; initializeAcpDeploymentPolicy({info:(value)=>logs.push(value),warn:()=>{}}); process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE='strict'; process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE='required'; console.log(JSON.stringify({summary:logs[0],trusted:isTrustedHostCompatibilityEnabled(),warn:allowsAcpBootstrapConfigAuditWarning()}));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}
test('startup validates both enums before use, legacy mapping is bounded, and the effective policy is frozen', () => {
  for (const [key, values] of [
    [policyKeys[0], ['', 'typo']],
    [policyKeys[1], ['', 'warn']],
  ]) {
    for (const value of values) {
      const child = policyChild({ [key]: value, CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1' });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, new RegExp(key));
    }
  }
  for (const [env, trusted, requested] of [
    [{}, false, 'required'],
    [{ CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1' }, true, 'warn-bootstrap-root'],
    [{ CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: 'true' }, false, 'required'],
    [
      { CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1', CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: 'strict' },
      false,
      'warn-bootstrap-root',
    ],
    [
      { CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: '1', CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE: 'required' },
      true,
      'required',
    ],
  ]) {
    const child = policyChild(env);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.trusted, trusted);
    assert.equal(result.summary.requestedAudit, requested);
    assert.equal(result.warn, process.platform === 'win32' && trusted && requested === 'warn-bootstrap-root');
  }
});

test(
  'Windows parent and real API job read the same persistent settings in a fresh terminal',
  { skip: process.platform !== 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'intranet-startup-'));
    const envFile = join(directory, '.env');
    const original =
      '# persistent fixture\r\nCAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE="trusted-host"\r\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE="warn-bootstrap-root"\r\n';
    writeFileSync(envFile, original);
    const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$v=[Console]::In.ReadToEnd() | ConvertFrom-Json
. $v.module
Import-HostDotEnv -Path $v.envFile
$parent=Get-AcpDeploymentModes
$job=Start-Job -ScriptBlock { param($module,$envFile)
  $ErrorActionPreference='Stop'; . $module
  Import-HostDotEnv -Path $envFile
  Get-AcpDeploymentModes
} -ArgumentList $v.module,$v.envFile
try {
  $child=Receive-Job -Job $job -Wait -ErrorAction Stop
  [Console]::Out.Write((@{parent=$parent;child=@{Bootstrap=$child.Bootstrap;RequestedAudit=$child.RequestedAudit;EffectiveAudit=$child.EffectiveAudit}} | ConvertTo-Json -Compress))
} finally { Remove-Job -Job $job -Force }
`;
    const output = execFileSync(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        input: JSON.stringify({ module: join(root, 'scripts/lib/host-dotenv.ps1'), envFile }),
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 20000,
      },
    );
    const modes = JSON.parse(output);
    assert.deepEqual(modes.parent, modes.child);
    assert.equal(modes.child.Bootstrap, 'trusted-host');
    assert.equal(modes.child.EffectiveAudit, 'warn-bootstrap-root');
    assert.equal(readFileSync(envFile, 'utf8'), original);
  },
);

test(
  'prepared Bash startup keeps only persisted ACP policies above .env.local; unrelated overrides remain',
  { skip: process.platform === 'win32' && !process.env.PROGRAMFILES },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'intranet-bash-'));
    writeFileSync(
      join(directory, '.env'),
      '# Clowder intranet preparation: fixture\nCAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=warn-bootstrap-root\nAUDIT_LOG_DIR=/fixture/audit\nUNRELATED=first\n',
    );
    writeFileSync(
      join(directory, '.env.local'),
      'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=strict\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=required\nAUDIT_LOG_DIR=/different/audit\nUNRELATED=second\n',
    );
    const source = readFileSync(join(root, 'scripts/start-dev.sh'), 'utf8');
    const section = source.slice(source.indexOf('if [ -f .env ]; then'), source.indexOf('# This launcher-only proof'));
    assert.ok(section.includes('_ACP_PERSIST_KEYS'));
    const script = `${section}\nprintf '%s|%s|%s|%s' "$CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE" "$CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE" "$AUDIT_LOG_DIR" "$UNRELATED"`;
    const bash = process.platform === 'win32' ? join(process.env.PROGRAMFILES, 'Git/bin/bash.exe') : 'bash';
    const output = execFileSync(bash, ['-c', script], { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(output, 'trusted-host|warn-bootstrap-root|/fixture/audit|second');
  },
);
