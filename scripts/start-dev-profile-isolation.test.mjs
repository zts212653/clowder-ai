import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());
const SYNC_SCRIPT = resolve(ROOT, 'scripts/sync-to-opensource.sh');

function createSandbox(envFile = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-start-dev-profile-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts/start-dev.sh'), join(dir, 'scripts', 'start-dev.sh'));

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
      assert.match(result.stdout, /EMBED=/);
      assert.match(result.stdout, /TTL=86400/);
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

  it('still allows .env overrides after strict sanitize', () => {
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
      assert.match(result.stdout, /ASR=1/);
      assert.match(result.stdout, /EMBED=/);
      assert.match(result.stdout, /TTL=123/);
      assert.match(result.stdout, /REDIS_PROFILE=custom/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe('cross-platform pnpm-start profile propagation (#421)', () => {
  it('package.json scripts.start routes through start-entry.mjs with --profile=opensource', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.match(
      pkg.scripts.start,
      /start-entry\.mjs start\b.*--profile=opensource/,
      'pnpm start must route through start-entry.mjs with --profile=opensource',
    );
  });

  it('start-entry.mjs sets CAT_CAFE_PROFILE and CAT_CAFE_STRICT_PROFILE_DEFAULTS for Windows when --profile is present', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/start-entry.mjs'), 'utf8');

    // Windows branch must extract --profile=* and convert to env vars
    assert.ok(
      source.includes('childEnv.CAT_CAFE_PROFILE = profileName'),
      'Windows path must set CAT_CAFE_PROFILE from --profile arg',
    );
    assert.ok(
      source.includes("childEnv.CAT_CAFE_STRICT_PROFILE_DEFAULTS = '1'"),
      'Windows path must set CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 when profile is present',
    );

    // Verify env is passed to child spawn
    assert.ok(source.includes('env: childEnv'), 'Windows spawn must use childEnv (which contains profile env vars)');
  });

  it('start-windows.ps1 clears inherited profile vars when strict mode is on', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    // Mirrors start-dev.sh clear_inherited_profile_env: must clear profile-controlled
    // vars BEFORE .env loading when CAT_CAFE_STRICT_PROFILE_DEFAULTS=1
    assert.ok(
      ps1.includes('CAT_CAFE_STRICT_PROFILE_DEFAULTS'),
      'start-windows.ps1 must check CAT_CAFE_STRICT_PROFILE_DEFAULTS for strict mode',
    );

    // Must clear the same vars as start-dev.sh
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

    // Must define opensource profile defaults that match start-dev.sh apply_profile_defaults
    assert.match(ps1, /'opensource'/, 'start-windows.ps1 must define opensource profile');
    assert.match(ps1, /'production'/, 'start-windows.ps1 must define production profile');
    assert.match(ps1, /'dev'/, 'start-windows.ps1 must define dev profile');

    // Verify resolve_config pattern: env override > profile default
    assert.ok(
      ps1.includes('GetEnvironmentVariable'),
      'start-windows.ps1 must check existing env before applying profile default',
    );
  });

  it('start-windows.ps1 reapplies profile defaults inside Start-Job after .env reload', () => {
    const ps1 = readFileSync(resolve(ROOT, 'scripts/start-windows.ps1'), 'utf8');

    // API job receives $profileDefaults param and reapplies after .env reload
    // (mirrors start-dev.sh resolve_config: env override > profile default)
    assert.ok(ps1.includes('$profileDefaults'), 'start-windows.ps1 must pass $profileDefaults to Start-Job');

    // The job must check if value is empty before applying default (resolve_config pattern)
    // Look for the pattern inside a ScriptBlock (Start-Job context)
    const jobBlocks = ps1.match(/Start-Job[\s\S]*?-ScriptBlock\s*\{([\s\S]*?)\}\s*-ArgumentList/g);
    assert.ok(jobBlocks && jobBlocks.length > 0, 'start-windows.ps1 must have Start-Job blocks');
    const apiJobBlock = jobBlocks[0];
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

    // Verify Start-Job is used (PS Start-Job inherits parent process env by default)
    assert.ok(ps1.includes('Start-Job'), 'start-windows.ps1 must use Start-Job (which inherits parent process env)');
  });
});

describe('sync-to-opensource public launch transforms', { skip: !existsSync(SYNC_SCRIPT) }, () => {
  it('exports opensource-pinned direct launch wrappers and runtime startup', () => {
    const result = spawnSync('bash', [SYNC_SCRIPT, '--dry-run', '--yes'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TERM: process.env.TERM ?? 'xterm-256color',
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/Export (?:complete|preserved) at:[^\n]*\n\s*(\/[^\n]+)/);
    assert.ok(match?.[1], output);

    const exportDir = match[1].trim();
    try {
      const pkg = JSON.parse(readFileSync(resolve(exportDir, 'package.json'), 'utf8'));
      const runtimeScript = readFileSync(resolve(exportDir, 'scripts/runtime-worktree.sh'), 'utf8');

      assert.match(pkg.scripts['dev:direct'], /start-entry\.mjs dev:direct --profile=opensource/);
      assert.match(pkg.scripts['start:direct'], /start-entry\.mjs start:direct --profile=opensource/);
      assert.equal(existsSync(resolve(exportDir, 'scripts/start-entry.mjs')), true);
      assert.equal(
        pkg.scripts['check:start-profile-isolation'],
        'node --test scripts/start-dev-profile-isolation.test.mjs',
      );
      assert.equal(existsSync(resolve(exportDir, 'cat-template.json')), true);
      assert.match(pkg.scripts.check, /check:start-profile-isolation/);
      assert.equal(existsSync(resolve(exportDir, 'scripts/download-source-overrides.sh')), true);
      assert.equal(existsSync(resolve(exportDir, 'scripts/start-dev-profile-isolation.test.mjs')), true);

      assert.match(
        runtimeScript,
        /exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 \.\/scripts\/start-dev\.sh --prod-web --profile=opensource/,
      );

      const envSource = spawnSync(
        'bash',
        ['-lc', 'set -euo pipefail\nset -a\nsource ./.env.example\nset +a\nprintf "%s" "$NEXT_PUBLIC_BRAND_NAME"'],
        {
          cwd: exportDir,
          env: {
            ...process.env,
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            TERM: process.env.TERM ?? 'xterm-256color',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(envSource.status, 0, envSource.stderr || envSource.stdout);
      assert.equal(envSource.stdout.trim(), 'Clowder AI');
    } finally {
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
