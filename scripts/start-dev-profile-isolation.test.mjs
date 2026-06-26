import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { buildWindowsStatus, resolveWindowsStatusPorts } from './lib/platform-status.mjs';

const ROOT = resolve(process.cwd());
const localRequire = createRequire(import.meta.url);

function resolvePackageBin(packageName) {
  const pkgPath = localRequire.resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[packageName];
  assert.equal(typeof bin, 'string', `${packageName} package.json must declare a bin entry`);
  return resolve(dirname(pkgPath), bin);
}

function createSandbox(envFile = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-start-dev-profile-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts/start-dev.sh'), join(dir, 'scripts', 'start-dev.sh'));
  cpSync(resolve(ROOT, 'scripts/lib/node-runtime-guard.sh'), join(dir, 'scripts/lib', 'node-runtime-guard.sh'));
  cpSync(resolve(ROOT, 'scripts/lib/redis-rdb-first.sh'), join(dir, 'scripts/lib', 'redis-rdb-first.sh'));

  const downloadOverrides = resolve(ROOT, 'scripts/download-source-overrides.sh');
  if (existsSync(downloadOverrides)) {
    cpSync(downloadOverrides, join(dir, 'scripts', 'download-source-overrides.sh'));
  }

  if (envFile) {
    writeFileSync(join(dir, '.env'), envFile, 'utf8');
  }

  return dir;
}

function runSourceOnly({ sandboxDir, env = {}, extraArgs = [] }) {
  const command = [
    `source scripts/start-dev.sh --source-only ${extraArgs.join(' ')}`,
    'printf "PROFILE=%s\\nASR=%s\\nPROXY=%s\\nTTS=%s\\nLLM=%s\\nEMBED=%s\\nTTL=%s\\nREDIS_PROFILE=%s\\n" "$PROFILE" "$ASR_ENABLED" "$ANTHROPIC_PROXY_ENABLED" "$TTS_ENABLED" "$LLM_POSTPROCESS_ENABLED" "${EMBED_ENABLED:-}" "$MESSAGE_TTL_SECONDS" "$REDIS_PROFILE"',
  ].join('; ');

  return spawnSync('bash', ['-lc', command], {
    cwd: sandboxDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TERM: process.env.TERM ?? 'xterm-256color',
      ...env,
    },
    encoding: 'utf8',
  });
}

function runApiLaunchCommand({ sandboxDir, env = {}, extraArgs = [] }) {
  const command = [
    `source scripts/start-dev.sh --source-only ${extraArgs.join(' ')}`,
    'printf "%s\\n" "$(api_launch_command)"',
  ].join('; ');

  return spawnSync('bash', ['-lc', command], {
    cwd: sandboxDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TERM: process.env.TERM ?? 'xterm-256color',
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('start-dev strict profile isolation', () => {
  it('ignores inherited shell env for profile-controlled vars when strict mode is on', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runSourceOnly({
        sandboxDir,
        env: {
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
          ANTHROPIC_PROXY_ENABLED: '1',
          ASR_ENABLED: '1',
          TTS_ENABLED: '1',
          LLM_POSTPROCESS_ENABLED: '1',
          EMBED_ENABLED: '1',
          MESSAGE_TTL_SECONDS: '0',
          THREAD_TTL_SECONDS: '0',
          TASK_TTL_SECONDS: '0',
          SUMMARY_TTL_SECONDS: '0',
          REDIS_PROFILE: 'dev',
        },
        extraArgs: ['--', '--profile=opensource'],
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PROFILE=opensource/);
      assert.match(result.stdout, /ASR=0/);
      assert.match(result.stdout, /PROXY=0/);
      assert.match(result.stdout, /TTS=0/);
      assert.match(result.stdout, /LLM=0/);
      assert.match(result.stdout, /EMBED=0/);
      assert.match(result.stdout, /TTL=0/);
      assert.match(result.stdout, /REDIS_PROFILE=opensource/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('production profile has TTL=0 and shares redis-opensource instance', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runSourceOnly({
        sandboxDir,
        env: {
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
        },
        extraArgs: ['--', '--profile=production'],
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PROFILE=production/);
      assert.match(result.stdout, /ASR=0/);
      assert.match(result.stdout, /PROXY=0/);
      assert.match(result.stdout, /TTL=0/);
      assert.match(result.stdout, /REDIS_PROFILE=opensource/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('still allows non-sidecar .env overrides after strict sanitize', () => {
    const sandboxDir = createSandbox('ASR_ENABLED=1\nMESSAGE_TTL_SECONDS=123\nREDIS_PROFILE=custom\n');
    try {
      const result = runSourceOnly({
        sandboxDir,
        env: {
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
          ANTHROPIC_PROXY_ENABLED: '1',
          ASR_ENABLED: '1',
          EMBED_ENABLED: '1',
          MESSAGE_TTL_SECONDS: '0',
          REDIS_PROFILE: 'dev',
        },
        extraArgs: ['--', '--profile=opensource'],
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PROFILE=opensource/);
      assert.match(result.stdout, /ASR=0/);
      assert.match(result.stdout, /EMBED=0/);
      assert.match(result.stdout, /TTL=123/);
      assert.match(result.stdout, /REDIS_PROFILE=custom/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('preserves explicit .env sidecar flags for API lifecycle without enabling legacy direct spawn', () => {
    const sandboxDir = createSandbox('ASR_ENABLED=1\nTTS_ENABLED=1\nWHISPER_PORT=19976\n');
    try {
      const command = [
        'source scripts/start-dev.sh --source-only -- --profile=opensource',
        'printf "ASR=%s\\nTTS=%s\\nLEGACY_ASR=%s\\nLEGACY_TTS=%s\\n" "$ASR_ENABLED" "$TTS_ENABLED" "${CAT_CAFE_SERVICE_ASR_ENABLED:-}" "${CAT_CAFE_SERVICE_TTS_ENABLED:-}"',
      ].join('; ');
      const result = spawnSync('bash', ['-lc', command], {
        cwd: sandboxDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TERM: process.env.TERM ?? 'xterm-256color',
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /ASR=0/);
      assert.match(result.stdout, /TTS=0/);
      assert.match(result.stdout, /LEGACY_ASR=1/);
      assert.match(result.stdout, /LEGACY_TTS=1/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('does NOT derive EMBED_ENABLED from EMBED_MODE (sidecar lifecycle owned by API startup reconciler)', () => {
    // EMBED_MODE only controls the API in-process embedding mode (off/shadow/on).
    // Sidecar startup is no longer triggered by EMBED_MODE; the API spawns
    // sidecars via /api/services/embedding-model/start based on
    // .cat-cafe/services.json (embedding-model.enabled).
    const sandboxDir = createSandbox('EMBED_MODE=on\n');
    try {
      const result = runSourceOnly({
        sandboxDir,
        env: {
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
        },
        extraArgs: ['--', '--profile=opensource'],
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PROFILE=opensource/);
      assert.match(result.stdout, /EMBED=0/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('bridges .env EMBED_ENABLED=1 to CAT_CAFE_SERVICE_EMBED_ENABLED for API lifecycle', () => {
    // When .env sets EMBED_ENABLED=1, the script must export
    // CAT_CAFE_SERVICE_EMBED_ENABLED=1 so the API startup reconciler knows to
    // launch the embedding sidecar.  A previous bug (d93b109d8) wrote the
    // source tag as "env/.env override" instead of ".env override", causing
    // preserve_explicit_service_flag_for_api() to skip the bridge.
    const sandboxDir = createSandbox('EMBED_ENABLED=1\n');
    try {
      const command = [
        'source scripts/start-dev.sh --source-only',
        'printf "SERVICE_EMBED=%s\\n" "${CAT_CAFE_SERVICE_EMBED_ENABLED:-unset}"',
      ].join('; ');
      const result = spawnSync('bash', ['-lc', command], {
        cwd: sandboxDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TERM: process.env.TERM ?? 'xterm-256color',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(
        result.stdout,
        /SERVICE_EMBED=1/,
        'EMBED_ENABLED=1 in .env must bridge to CAT_CAFE_SERVICE_EMBED_ENABLED=1',
      );
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('respects explicit EMBED_ENABLED=0 override even when EMBED_MODE=on', () => {
    const sandboxDir = createSandbox('EMBED_MODE=on\nEMBED_ENABLED=0\n');
    try {
      const result = runSourceOnly({
        sandboxDir,
        env: {
          CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
        },
        extraArgs: ['--', '--profile=opensource'],
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PROFILE=opensource/);
      assert.match(result.stdout, /EMBED=0/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('marks default dev API launches with NODE_ENV=development for child process semantics', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runApiLaunchCommand({ sandboxDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /NODE_ENV=development/, result.stdout);
      assert.match(result.stdout, /pnpm run dev/, result.stdout);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('keeps API dev watcher away from build artifacts', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/api/package.json'), 'utf8'));
    const devScript = pkg.scripts.dev;

    assert.match(devScript, /\btsx watch\b/, devScript);
    assert.match(devScript, /--exclude "dist\/\*\*"/, devScript);
    assert.match(devScript, /--exclude "\.\.\/shared\/dist\/\*\*"/, devScript);

    const help = spawnSync(process.execPath, [resolvePackageBin('tsx'), 'watch', '--help'], {
      cwd: resolve(ROOT, 'packages/api'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '',
      },
    });
    assert.equal(help.status, 0, help.error?.message || help.stderr || help.stdout);
    const helpText = `${help.stdout}\n${help.stderr}`;
    assert.match(helpText, /--exclude <string>/);
    assert.match(helpText, /--ignore <string>.*Deprecated: use --exclude/);
  });

  it('marks opensource profile API launches WITHOUT --prod-web as NODE_ENV=development (dev:direct path)', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runApiLaunchCommand({
        sandboxDir,
        env: { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' },
        extraArgs: ['--', '--profile=opensource'],
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /NODE_ENV=development/, result.stdout);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('marks --prod-web + --profile=opensource API launches as NODE_ENV=production (runtime/start:direct path)', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runApiLaunchCommand({
        sandboxDir,
        env: { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' },
        extraArgs: ['--prod-web', '--', '--profile=opensource'],
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /NODE_ENV=production/, result.stdout);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('runs --prod-web API launches without the dev watcher even when no env wrapper injects it', () => {
    const sandboxDir = createSandbox();
    try {
      const result = runApiLaunchCommand({
        sandboxDir,
        extraArgs: ['--prod-web'],
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /pnpm run start/, result.stdout);
      assert.doesNotMatch(result.stdout, /pnpm run dev/, result.stdout);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe('cross-platform pnpm-start profile propagation (#421)', () => {
  it('package.json scripts.start routes through start-entry.mjs', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.start, /start-entry\.mjs start\b/, 'pnpm start must route through start-entry.mjs');
  });

  it('package.json scripts.start:status routes through start-entry.mjs for Windows pnpm shells', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

    assert.match(
      pkg.scripts['start:status'],
      /start-entry\.mjs status\b/,
      'pnpm start:status must not invoke ./scripts/start-dev.sh directly',
    );
  });

  it('Windows status succeeds only when required API and web PID files are running', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'cc-windows-status-'));
    try {
      const { apiPort, webPort } = resolveWindowsStatusPorts({ projectRoot: sandboxDir, env: {} });
      const runDir = join(sandboxDir, '.cat-cafe', 'run', 'windows');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, `api-${apiPort}.pid`), '41\n');
      writeFileSync(join(runDir, `web-${webPort}.pid`), '42\n');
      writeFileSync(join(runDir, 'embed-9878.pid'), '999\n');

      const result = buildWindowsStatus({
        projectRoot: sandboxDir,
        env: {},
        pidIsRunning: (pid) => new Set([41, 42]).has(pid),
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.lines, [
        'Clowder AI Windows status',
        `  api-${apiPort}: running (PID: 41)`,
        `  web-${webPort}: running (PID: 42)`,
      ]);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('Windows status fails when optional or stale PID files exist but a required service is missing', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'cc-windows-status-'));
    try {
      const { apiPort, webPort } = resolveWindowsStatusPorts({ projectRoot: sandboxDir, env: {} });
      const runDir = join(sandboxDir, '.cat-cafe', 'run', 'windows');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, `api-${apiPort}.pid`), '41\n');
      writeFileSync(join(runDir, 'embed-9878.pid'), '999\n');

      const result = buildWindowsStatus({
        projectRoot: sandboxDir,
        env: {},
        pidIsRunning: (pid) => new Set([41, 999]).has(pid),
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.lines, [
        'Clowder AI Windows status',
        `  api-${apiPort}: running (PID: 41)`,
        `  web-${webPort}: not running (missing PID file)`,
      ]);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('Windows status reads active ports from .env before falling back to home defaults', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'cc-windows-status-'));
    try {
      writeFileSync(join(sandboxDir, '.env'), 'API_SERVER_PORT=3112\nFRONTEND_PORT=3111\n');
      const runDir = join(sandboxDir, '.cat-cafe', 'run', 'windows');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'api-3112.pid'), '51\n');
      writeFileSync(join(runDir, 'web-3111.pid'), '52\n');

      const result = buildWindowsStatus({
        projectRoot: sandboxDir,
        env: {},
        pidIsRunning: (pid) => new Set([51, 52]).has(pid),
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.lines, [
        'Clowder AI Windows status',
        '  api-3112: running (PID: 51)',
        '  web-3111: running (PID: 52)',
      ]);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('start-entry.mjs sets CAT_CAFE_PROFILE and CAT_CAFE_STRICT_PROFILE_DEFAULTS for Windows when --profile is present', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/start-entry.mjs'), 'utf8');

    assert.ok(
      source.includes('childEnv.CAT_CAFE_PROFILE = profileName'),
      'Windows path must set CAT_CAFE_PROFILE from --profile arg',
    );
    assert.ok(
      source.includes("childEnv.CAT_CAFE_STRICT_PROFILE_DEFAULTS = '1'"),
      'Windows path must set CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 when profile is present',
    );

    assert.ok(source.includes('env: childEnv'), 'Windows spawn must use childEnv (which contains profile env vars)');
  });

  it('start-entry.mjs defaults direct Unix starts to connector gateway autostart off', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/start-entry.mjs'), 'utf8');
    const unixDispatchStart = source.indexOf('// Unix: dispatch based on mode');
    const startDirectBlock = source.slice(
      source.indexOf("mode === 'start:direct'", unixDispatchStart),
      source.indexOf("} else if (mode === 'dev:direct'", unixDispatchStart),
    );
    const devDirectBlock = source.slice(
      source.indexOf("mode === 'dev:direct'", unixDispatchStart),
      source.indexOf('} else {', source.indexOf("mode === 'dev:direct'", unixDispatchStart)),
    );

    assert.match(
      source,
      /CONNECTOR_GATEWAY_AUTOSTART:\s*'0'/,
      'direct fail-closed helper must default CONNECTOR_GATEWAY_AUTOSTART=0',
    );
    assert.match(
      startDirectBlock,
      /directConnectorAutostartFailClosed/,
      'start:direct must explicitly fail closed for preconfigured IM connector autostart',
    );
    assert.match(
      devDirectBlock,
      /directConnectorAutostartFailClosed/,
      'dev:direct must explicitly fail closed for preconfigured IM connector autostart',
    );
  });

  it('start-entry.mjs marks Unix runtime-worktree starts as no-watch before dispatch', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/start-entry.mjs'), 'utf8');
    const unixDispatchStart = source.indexOf('// Unix: dispatch based on mode');
    const runtimeStartBlock = source.slice(
      source.indexOf("mode === 'start'", unixDispatchStart),
      source.indexOf("} else if (mode === 'start:direct'", unixDispatchStart),
    );

    assert.match(
      runtimeStartBlock,
      /CAT_CAFE_DIRECT_NO_WATCH:\s*'1'/,
      'pnpm start must mark runtime-worktree startup as no-watch before dispatching',
    );
  });

  it('start-windows.ps1 clears inherited profile vars when strict mode is on', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    assert.ok(
      ps1.includes('CAT_CAFE_STRICT_PROFILE_DEFAULTS'),
      'start-windows.ps1 must check CAT_CAFE_STRICT_PROFILE_DEFAULTS for strict mode',
    );

    for (const v of [
      'ANTHROPIC_PROXY_ENABLED',
      'ASR_ENABLED',
      'TTS_ENABLED',
      'LLM_POSTPROCESS_ENABLED',
      'REDIS_PROFILE',
    ]) {
      assert.ok(ps1.includes(v), `start-windows.ps1 must reference profile var ${v}`);
    }
  });

  it('start-windows.ps1 applies profile defaults matching start-dev.sh opensource profile', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    assert.match(ps1, /'opensource'/, 'start-windows.ps1 must define opensource profile');
    assert.match(ps1, /'production'/, 'start-windows.ps1 must define production profile');
    assert.match(ps1, /'dev'/, 'start-windows.ps1 must define dev profile');

    assert.ok(
      ps1.includes('GetEnvironmentVariable'),
      'start-windows.ps1 must check existing env before applying profile default',
    );
    assert.ok(
      ps1.includes('API startup reconciler'),
      'start-windows.ps1 must delegate sidecar lifecycle to the API startup reconciler',
    );
    assert.ok(
      !/Start-Job[\s\S]*embed-server\.ps1/i.test(ps1),
      'start-windows.ps1 must not directly Start-Job embed-server.ps1',
    );
    assert.ok(
      ps1.includes('CAT_CAFE_SERVICE_ASR_ENABLED') && ps1.includes('CAT_CAFE_SERVICE_TTS_ENABLED'),
      'start-windows.ps1 must preserve explicit .env sidecar flags for API startup lifecycle',
    );
  });

  it('start-windows.ps1 reapplies profile defaults inside Start-Job after .env reload', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    assert.ok(ps1.includes('$profileDefaults'), 'start-windows.ps1 must pass $profileDefaults to Start-Job');

    const jobBlocks = ps1.match(/Start-Job[\s\S]*?-ScriptBlock\s*\{([\s\S]*?)\}\s*-ArgumentList/g);
    assert.ok(jobBlocks && jobBlocks.length > 0, 'start-windows.ps1 must have Start-Job blocks');
    const apiJobBlock = jobBlocks.find((b) => b.includes('-Name "api"'));
    assert.ok(apiJobBlock, 'start-windows.ps1 must have an API Start-Job block');
    assert.ok(
      apiJobBlock.includes('profileDefaults') && apiJobBlock.includes('GetEnvironmentVariable'),
      'API job must reapply profileDefaults with env-check after .env reload',
    );
  });

  it('start-windows.ps1 runtimeEnvOverrides does not clobber profile vars', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    const overridesMatch = ps1.match(/\$runtimeEnvOverrides\s*=\s*@\{([^}]+)\}/s);
    assert.ok(overridesMatch, 'start-windows.ps1 must define $runtimeEnvOverrides');
    const overridesBlock = overridesMatch[1];
    assert.ok(
      !overridesBlock.includes('CAT_CAFE_PROFILE'),
      'runtimeEnvOverrides must not override CAT_CAFE_PROFILE (it flows via env inheritance)',
    );
    assert.ok(
      !overridesBlock.includes('CAT_CAFE_STRICT_PROFILE'),
      'runtimeEnvOverrides must not override CAT_CAFE_STRICT_PROFILE_DEFAULTS (it flows via env inheritance)',
    );

    assert.ok(ps1.includes('Start-Job'), 'start-windows.ps1 must use Start-Job (which inherits parent process env)');
  });

  it('start-windows.ps1 passes explicit service lifecycle flags into the API job', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');
    const overridesMatch = ps1.match(/\$runtimeEnvOverrides\s*=\s*@\{([^}]+)\}/s);
    assert.ok(overridesMatch, 'start-windows.ps1 must define $runtimeEnvOverrides');
    const overridesBlock = overridesMatch[1];

    for (const flag of [
      'CAT_CAFE_SERVICE_ASR_ENABLED',
      'CAT_CAFE_SERVICE_TTS_ENABLED',
      'CAT_CAFE_SERVICE_LLM_POSTPROCESS_ENABLED',
      'CAT_CAFE_SERVICE_EMBED_ENABLED',
      'CAT_CAFE_SERVICE_AUDIO_ENABLED',
    ]) {
      assert.match(
        overridesBlock,
        new RegExp(`${flag}\\s*=\\s*\\$env:${flag}`),
        `runtimeEnvOverrides must pass ${flag} into the API job`,
      );
    }
  });

  it('start-windows.ps1 marks production Redis API job as global sidecar owner', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');
    const overridesMatch = ps1.match(/\$runtimeEnvOverrides\s*=\s*@\{([^}]+)\}/s);
    assert.ok(overridesMatch, 'start-windows.ps1 must define $runtimeEnvOverrides');
    const overridesBlock = overridesMatch[1];

    assert.match(
      ps1,
      /\$globalSidecarOwner\s*=\s*if\s*\(\$useRedis\s*-and\s*-not\s*\$Dev\)\s*\{\s*['"]1['"]\s*\}\s*else\s*\{\s*\$null\s*\}/,
      'Windows production Redis starts must opt into global sidecar ownership, while -Dev/-Memory stay non-owner',
    );
    assert.match(
      overridesBlock,
      /CAT_CAFE_PROVISION_GLOBAL_SIDECAR\s*=\s*\$globalSidecarOwner/,
      'runtimeEnvOverrides must pass CAT_CAFE_PROVISION_GLOBAL_SIDECAR into the API job after dotenv reload',
    );
  });

  it('start-windows.ps1 marks production API job as connector runtime but leaves -Dev unmarked', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');
    const overridesMatch = ps1.match(/\$runtimeEnvOverrides\s*=\s*@\{([^}]+)\}/s);
    assert.ok(overridesMatch, 'start-windows.ps1 must define $runtimeEnvOverrides');
    const overridesBlock = overridesMatch[1];

    assert.match(
      ps1,
      /\$runtimeRootMarker\s*=\s*if\s*\(-not\s*\$Dev\)\s*\{\s*\$ProjectRoot\s*\}\s*else\s*\{\s*\$null\s*\}/,
      'Windows production starts must mark the API job as runtime, while -Dev stays fail-closed',
    );
    assert.match(
      overridesBlock,
      /CAT_CAFE_RUNTIME_ROOT\s*=\s*\$runtimeRootMarker/,
      'runtimeEnvOverrides must pass CAT_CAFE_RUNTIME_ROOT into the API job after dotenv reload',
    );
    assert.match(
      ps1,
      /\$workspaceRootMarker\s*=\s*if\s*\(-not\s*\$Dev\)\s*\{\s*[\s\S]*\$ProjectRoot[\s\S]*\}\s*else\s*\{\s*\$env:CAT_CAFE_WORKSPACE_ROOT\s*\}/,
      'Windows production starts must default CAT_CAFE_WORKSPACE_ROOT to $ProjectRoot while preserving explicit env overrides',
    );
    assert.match(
      ps1,
      /\$workspaceRootMarker\s*=\s*if\s*\(-not\s*\$Dev\)\s*\{\s*if\s*\(\$env:CAT_CAFE_WORKSPACE_ROOT\)\s*\{\s*\$env:CAT_CAFE_WORKSPACE_ROOT\s*\}\s*else\s*\{\s*\$ProjectRoot\s*\}\s*\}/,
      'Windows production CAT_CAFE_WORKSPACE_ROOT must prefer explicit $env override before falling back to $ProjectRoot (guards against accidental override-stripping refactors)',
    );
    assert.match(
      overridesBlock,
      /CAT_CAFE_WORKSPACE_ROOT\s*=\s*\$workspaceRootMarker/,
      'runtimeEnvOverrides must pass CAT_CAFE_WORKSPACE_ROOT into the API job after dotenv reload',
    );
  });

  it('start-windows.ps1 assigns NODE_ENV inside the API Start-Job', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');
    const jobBlocks = ps1.match(/Start-Job[\s\S]*?-ScriptBlock\s*\{([\s\S]*?)\}\s*-ArgumentList/g);
    assert.ok(jobBlocks && jobBlocks.length > 0, 'start-windows.ps1 must have Start-Job blocks');
    const apiJobBlock = jobBlocks.find((b) => b.includes('-Name "api"'));
    assert.ok(apiJobBlock, 'start-windows.ps1 must have an API Start-Job block');
    assert.match(ps1, /NODE_ENV\s*=\s*\$apiNodeEnv/, 'Windows runtime env overrides must include NODE_ENV');
    assert.match(apiJobBlock, /runtimeEnvOverrides/, 'API job must consume runtimeEnvOverrides');
  });
});

describe('embedding sidecar startup guards', () => {
  it('does not silently fall back to sentence-transformers on Apple Silicon', () => {
    const apiScript = readFileSync(resolve(ROOT, 'scripts/services/embed-api.py'), 'utf8');

    assert.match(apiScript, /EMBED_ALLOW_ST_FALLBACK/);
    assert.match(apiScript, /platform\.system\(\)\s*==\s*["']Darwin["']/);
    assert.match(apiScript, /platform\.machine\(\)\s*==\s*["']arm64["']/);
    assert.match(apiScript, /SentenceTransformer fallback disabled/);
  });

  it('pins embedding install dependencies away from transformers v5 drift', () => {
    const installScript = readFileSync(resolve(ROOT, 'scripts/services/embed-install.sh'), 'utf8');
    const installPs1 = readFileSync(resolve(ROOT, 'scripts/services/embed-install.ps1'), 'utf8');
    const apiScript = readFileSync(resolve(ROOT, 'scripts/services/embed-api.py'), 'utf8');

    assert.match(installScript, /PIP_DEPS_ARM64=.*transformers<5/);
    assert.match(installScript, /PIP_DEPS_OTHER=.*transformers<5/);
    assert.match(installScript, /PIP_DEPS_ARM64=.*huggingface-hub\[hf_xet\]<1\.0/);
    assert.match(installScript, /PIP_DEPS_OTHER=.*huggingface-hub\[hf_xet\]<1\.0/);
    assert.match(installScript, /PIP_DEPS_ARM64=.*httpx\[socks\]/);
    assert.match(installScript, /PIP_DEPS_OTHER=.*httpx\[socks\]/);
    assert.equal((installPs1.match(/'httpx\[socks\]'/g) ?? []).length, 2);
    assert.match(apiScript, /mlx_embeddings\.utils/);
    assert.match(apiScript, /attn_implementation["']:\s*["']eager/);
  });

  it('keeps setup docs aligned with Console-managed embedding service lifecycle', () => {
    const setupDoc = readFileSync(resolve(ROOT, 'SETUP.md'), 'utf8');
    const setupZhDoc = readFileSync(resolve(ROOT, 'SETUP.zh-CN.md'), 'utf8');

    assert.match(setupDoc, /install the \*\*Embedding\*\* service from Console settings/i);
    assert.doesNotMatch(setupDoc, /scripts\/embed-server\.sh/);
    assert.match(setupZhDoc, /Console 设置里安装并启用 \*\*Embedding\*\* 服务/);
    assert.doesNotMatch(setupZhDoc, /EMBED_MODE.*on/);
    assert.doesNotMatch(setupZhDoc, /scripts\/embed-server\.sh/);
  });
});

describe('TTS sidecar startup guards', () => {
  it('preloads runtime voice assets during install and starts from cache', () => {
    const installScript = readFileSync(resolve(ROOT, 'scripts/services/tts-install.sh'), 'utf8');
    const installPs1 = readFileSync(resolve(ROOT, 'scripts/services/tts-install.ps1'), 'utf8');
    const serverScript = readFileSync(resolve(ROOT, 'scripts/services/tts-server.sh'), 'utf8');
    const apiScript = readFileSync(resolve(ROOT, 'scripts/services/tts-api.py'), 'utf8');

    assert.match(installScript, /POST_INSTALL_HOOK_ARM64=["']tts_install_arm64_warmup["']/);
    assert.match(installScript, /generate_audio/);
    assert.match(installScript, /zm_yunjian/);
    assert.match(installScript, /_CATCAFE_HF_PROXY_FOR_DOWNLOAD/);
    assert.match(serverScript, /HF_HUB_OFFLINE/);
    assert.match(serverScript, /mlx-audio\|qwen3-clone/);
    assert.doesNotMatch(apiScript, /except Exception:\s*\n\s*pass\s+# Warmup may fail/);
    assert.match(apiScript, /os\.environ\.get\(["']CAT_CAFE_HOME["']\)/);
    assert.match(apiScript, /CAT_CAFE_HOME[\s\S]*piper-models/);
    assert.doesNotMatch(apiScript, /Path\.home\(\)\s*\/\s*["']\.cat-cafe["']\s*\/\s*["']piper-models["']/);
    assert.match(installScript, /HF_ENDPOINT/);
    assert.match(installPs1, /HF_ENDPOINT/);
    assert.doesNotMatch(installScript, /base="https:\/\/huggingface\.co\/rhasspy\/piper-voices/);
    assert.doesNotMatch(installPs1, /\{ "https:\/\/huggingface\.co\/rhasspy\/piper-voices/);
  });
});

describe('Whisper sidecar startup guards', () => {
  it('preloads faster-whisper model artifacts via snapshot_download before runtime load', () => {
    const installTemplate = readFileSync(resolve(ROOT, 'scripts/services/install-template.sh'), 'utf8');
    const prereqPs1 = readFileSync(resolve(ROOT, 'scripts/services/prereq-check.ps1'), 'utf8');

    assert.match(installTemplate, /from faster_whisper\.utils import _MODELS/);
    assert.match(installTemplate, /from huggingface_hub import snapshot_download/);
    assert.match(installTemplate, /'faster-whisper snapshot download'/);
    assert.match(installTemplate, /snapshot_download\(repo_id,/);
    assert.match(installTemplate, /WhisperModel\(model_path,/);
    assert.doesNotMatch(installTemplate, /WhisperModel\(sys\.argv\[1\]/);
    assert.doesNotMatch(installTemplate, /from faster_whisper\.utils import download_model/);

    assert.match(prereqPs1, /from faster_whisper\.utils import _MODELS/);
    assert.match(prereqPs1, /from huggingface_hub import snapshot_download/);
    assert.match(prereqPs1, /'faster-whisper snapshot download'/);
    assert.match(prereqPs1, /snapshot_download\(repo_id,/);
    assert.match(prereqPs1, /raise ValueError\(f'Invalid faster-whisper model \{model_id!r\},/);
    assert.match(prereqPs1, /WhisperModel\(model_path,/);
    assert.doesNotMatch(prereqPs1, /WhisperModel\(sys\.argv\[1\]/);
    assert.doesNotMatch(prereqPs1, /from faster_whisper\.utils import download_model/);
    assert.doesNotMatch(prereqPs1, /raise ValueError\(f"Invalid faster-whisper model/);
  });

  it('normalizes socks proxy env before HuggingFace runtime loads', () => {
    const helperPath = resolve(ROOT, 'scripts/services/proxy-env.sh');
    const helperPs1Path = resolve(ROOT, 'scripts/services/proxy-env.ps1');
    const huggingFaceServiceScripts = [
      'scripts/services/whisper-server.sh',
      'scripts/services/embed-server.sh',
      'scripts/services/llm-postprocess-server.sh',
      'scripts/services/tts-server.sh',
      'scripts/services/install-template.sh',
    ];
    const result = spawnSync(
      'bash',
      [
        '-lc',
        [
          `source "${helperPath}"`,
          'HTTP_PROXY=socks://127.0.0.1:7897/',
          'HTTPS_PROXY=socks://127.0.0.1:7897/',
          'ALL_PROXY=socks5h://127.0.0.1:7897/',
          'normalize_socks_proxy_env',
          'printf "%s\\n%s\\n%s\\n" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY"',
        ].join('; '),
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      ['socks5://127.0.0.1:7897/', 'socks5://127.0.0.1:7897/', 'socks5h://127.0.0.1:7897/'].join('\n') + '\n',
    );
    for (const relativePath of huggingFaceServiceScripts) {
      const script = readFileSync(resolve(ROOT, relativePath), 'utf8');
      assert.match(script, /normalize_socks_proxy_env/, `${relativePath} must normalize inherited proxy env`);
    }

    const helperPs1 = readFileSync(helperPs1Path, 'utf8');
    assert.match(helperPs1, /function\s+Normalize-SocksProxyEnv/);
    assert.match(helperPs1, /socks:\/\/\*/);
    assert.match(helperPs1, /socks5:\/\//);

    for (const relativePath of [
      'scripts/services/whisper-server.ps1',
      'scripts/services/embed-server.ps1',
      'scripts/services/llm-postprocess-server.ps1',
      'scripts/services/tts-server.ps1',
    ]) {
      const script = readFileSync(resolve(ROOT, relativePath), 'utf8');
      assert.match(script, /proxy-env\.ps1/, `${relativePath} must load PowerShell proxy normalization`);
      assert.match(script, /Normalize-SocksProxyEnv/, `${relativePath} must normalize inherited proxy env`);
    }
  });
});

describe('Windows Python resolver guards', () => {
  it('does not block behind a Python install lock after another installer has finished', () => {
    const resolver = readFileSync(resolve(ROOT, 'scripts/services/python-resolve.ps1'), 'utf8');
    const lockFunction = resolver.match(/function Install-PythonToProjectDir \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.ok(lockFunction.includes('Try-ProjectPython'), 'lock wait path must re-check project Python');
    assert.match(lockFunction, /WaitOne\(\[TimeSpan\]::FromSeconds\(/);
    assert.doesNotMatch(lockFunction, /WaitOne\(\[TimeSpan\]::FromMinutes\(10\)\)/);
    assert.match(lockFunction, /Project Python already present and valid \(installed by concurrent install\)/);
  });

  it('bounds Windows portable Python downloads and retries the alternate proxy mode', () => {
    const resolver = readFileSync(resolve(ROOT, 'scripts/services/python-resolve.ps1'), 'utf8');
    const innerFunction = resolver.match(/function Install-PythonToProjectDirInner \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(innerFunction, /\$downloadTimeoutSec\s*=/);
    assert.match(innerFunction, /foreach\s*\(\$downloadMode\s+in\s+\$downloadModes\)/);
    assert.match(innerFunction, /Invoke-WebRequest[\s\S]*-TimeoutSec\s+\$downloadTimeoutSec/);
    assert.match(innerFunction, /Retrying Python download via/);
  });
});
