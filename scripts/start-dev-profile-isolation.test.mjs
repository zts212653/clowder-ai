import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());

function createSandbox(envFile = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-start-dev-profile-'));
  cpSync(resolve(ROOT, 'scripts/start-dev.sh'), join(dir, 'scripts', 'start-dev.sh'), {
    force: true,
    recursive: false,
  });
  cpSync(resolve(ROOT, 'scripts/download-source-overrides.sh'), join(dir, 'scripts', 'download-source-overrides.sh'), {
    force: true,
    recursive: false,
  });
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

describe('start-dev direct profile isolation', () => {
  it('strict profile mode ignores inherited shell env for profile-controlled vars', () => {
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

  it('strict profile mode still allows .env overrides after sanitize', () => {
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

  it('package direct-launch wrappers pin strict profile defaults to opensource', () => {
    const pkg = JSON.parse(
      spawnSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync("package.json", "utf8"))'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout,
    );

    assert.match(pkg.scripts['dev:direct'], /CAT_CAFE_STRICT_PROFILE_DEFAULTS=1/);
    assert.match(pkg.scripts['start:direct'], /CAT_CAFE_STRICT_PROFILE_DEFAULTS=1/);
    assert.match(pkg.scripts['dev:direct'], /--profile=opensource/);
    assert.match(pkg.scripts['start:direct'], /--profile=opensource/);
  });

  it('runtime-worktree start injects opensource profile and strict env isolation', () => {
    const runtimeScript = readFileSync(resolve(ROOT, 'scripts/runtime-worktree.sh'), 'utf8');

    assert.match(
      runtimeScript,
      /exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 \.\/scripts\/start-dev\.sh --prod-web --profile=opensource/,
    );
  });
});
