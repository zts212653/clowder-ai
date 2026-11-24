import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'upgrade launch reads installed identity while retaining an isolated home',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'desktop-launch-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = `
    $ErrorActionPreference='Stop'
    $tokens=$null
    $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($env:LAUNCH_VERIFIER,[ref]$tokens,[ref]$errors)
    if ($errors) { throw 'Cannot parse verifier' }
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-Owned'},$true)
    Invoke-Expression $function.Extent.Text
    $UseInstalledIdentity=$env:LAUNCH_IDENTITY_MODE -eq 'installed'
    $records=[Collections.Generic.List[object]]::new()
    $state=Join-Path $env:LAUNCH_TEST_ROOT 'state'
    $probe='process.stdout.write(JSON.stringify({home:process.env.HOME,instance:process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT??null,ports:[process.env.FRONTEND_PORT??null,process.env.API_SERVER_PORT??null,process.env.REDIS_PORT??null],token:process.env.GH_TOKEN??null}))'
    $child=Start-Owned $env:LAUNCH_PROBE_NODE @('-e',$probe) $env:LAUNCH_TEST_ROOT $state @(35471,35472,36471) 'probe'
    if (-not $child.WaitForExit(10000) -or $child.ExitCode -ne 0) { throw 'Launch probe failed' }
    $records[0].stdout.Result
  `;
    for (const mode of ['explicit', 'installed']) {
      const result = JSON.parse(
        execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_TOKEN: 'inert-test-token',
            LAUNCH_VERIFIER: fileURLToPath(new URL('./windows.ps1', import.meta.url)),
            LAUNCH_PROBE_NODE: process.execPath,
            LAUNCH_TEST_ROOT: root,
            LAUNCH_IDENTITY_MODE: mode,
          },
        }),
      );
      assert.equal(result.home, path.join(root, 'state', 'home'));
      assert.equal(result.token, null);
      assert.equal(result.instance, mode === 'installed' ? null : path.join(root, 'state'));
      assert.deepEqual(result.ports, mode === 'installed' ? [null, null, null] : ['35471', '35472', '36471']);
    }
  },
);
