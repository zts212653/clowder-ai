import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { deploymentDefaults } from '../../packages/shared/src/deployment-defaults.ts';
import { loadEnvRegistrySource } from '../lib/env-registry-source.mjs';
import { resolveWindowsStatusPorts } from '../lib/platform-status.mjs';
import { expectedApiPort, expectedFrontendPort, ROOT, readPowerShellFallback } from './context.mjs';

export function registerCodeDefaultsPart1() {
  it('deployment defaults match this edition and the public env template', () => {
    assert.equal(String(deploymentDefaults.apiPort), expectedApiPort);
    assert.equal(String(deploymentDefaults.webPort), expectedFrontendPort);
    const resolved = resolveWindowsStatusPorts({ projectRoot: tmpdir(), env: {} });
    assert.deepEqual(resolved, { apiPort: expectedApiPort, webPort: expectedFrontendPort });
  });

  for (const [file, expressions] of [
    ['packages/api/src/index.ts', ['API_SERVER_PORT ?? String(deploymentDefaults.apiPort)']],
    ['packages/api/src/config/ConfigRegistry.ts', ['API_SERVER_PORT ?? String(deploymentDefaults.apiPort)']],
    ['packages/api/src/config/env-registry.ts', ['defaultValue: String(deploymentDefaults.apiPort)']],
    ['packages/api/src/config/frontend-origin.ts', ['DEFAULT_FRONTEND_BASE_URL = deploymentDefaults.frontendBaseUrl']],
    [
      'scripts/start-dev.sh',
      [
        'read-deployment-default.mjs" apiPort',
        'read-deployment-default.mjs" webPort',
        'API_PORT=${API_SERVER_PORT:-$DEFAULT_API_PORT}',
        'WEB_PORT=${FRONTEND_PORT:-$DEFAULT_WEB_PORT}',
      ],
    ],
    [
      'scripts/setup.sh',
      [
        'API_SERVER_PORT=$DEPLOYMENT_API_PORT',
        'FRONTEND_PORT=$DEPLOYMENT_WEB_PORT',
        'NEXT_PUBLIC_API_URL=$DEPLOYMENT_API_URL',
      ],
    ],
  ]) {
    it(`${file} consumes shared deployment defaults`, () => {
      const source =
        file === 'packages/api/src/config/env-registry.ts'
          ? loadEnvRegistrySource(resolve(ROOT, file))
          : readFileSync(resolve(ROOT, file), 'utf8');
      for (const expression of expressions) assert.ok(source.includes(expression), `${file}: ${expression}`);
    });
  }

  for (const file of ['start-windows.ps1', 'stop-windows.ps1', 'install.ps1']) {
    it(`${file} reads selected data and fails before service actions on a failed read`, () => {
      const source = readFileSync(resolve(ROOT, 'scripts', file), 'utf8');
      assert.match(source, /read-deployment-default\.mjs"\) --json/);
      assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
      assert.match(source, /\$deploymentDefaults\.apiPort/);
      assert.match(source, /\$deploymentDefaults\.webPort/);
      assert.doesNotMatch(source, /else \{ "300[12]" \}|\$(?:Api|Web)Port = 300[12]/);
    });
  }

  it('setup.sh leaves TTS_CACHE_DIR unset so the API uses the stable user-data default', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      !/^TTS_CACHE_DIR=/m.test(content),
      'setup.sh must not pin the TTS cache to a checkout-relative directory',
    );
  });

  it('runtime-worktree.sh is the explicit global agent-key sidecar owner', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/runtime-worktree.sh'), 'utf-8');
    const ownerExports = content.match(/export CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1/g) ?? [];
    assert.ok(
      ownerExports.length >= 2,
      'runtime-worktree.sh must mark both in-place and runtime-worktree starts as global sidecar owner',
    );
  });

  it('alpha-worktree.sh does not own the global agent-key sidecar', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/alpha-worktree.sh'), 'utf-8');
    assert.doesNotMatch(
      content,
      /export CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1/,
      'alpha uses dedicated Redis 6397 and must not overwrite runtime global agent-key sidecars',
    );
  });

  it('start-windows.ps1 Redis fallback uses repo-local default', () => {
    const fallback = readPowerShellFallback(
      'scripts/start-windows.ps1',
      /\$RedisPort = if \(\$env:REDIS_PORT\) \{ \$env:REDIS_PORT \} else \{ "(\d+)" \}/,
    );
    assert.equal(fallback, '6399');
  });

  it('stop-windows.ps1 Redis fallback uses repo-local default', () => {
    const fallback = readPowerShellFallback('scripts/stop-windows.ps1', /\$RedisPort = (\d+)/);
    assert.equal(fallback, '6399');
  });

  it('install.ps1 Redis fallback uses repo-local default', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/install.ps1'), 'utf-8');
    assert.ok(content.includes('REDIS_PORT=6399'));
  });
}
