import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const scriptPath = resolve(import.meta.dirname, 'sync-to-opensource.sh');

test(
  'the real writer commits ignored exported assets without including unrelated ignored target files',
  {
    skip: !existsSync(scriptPath),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-commit-closure-'));
    const target = join(root, 'public');
    const filtered = join(root, 'filtered');
    const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
    const write = (base, path, value) => {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), value);
    };
    try {
      mkdirSync(target);
      mkdirSync(filtered);
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      write(target, '.gitignore', '*.mp4\n*.bin\n.env\ncat-config.json\n');
      git('add', '.gitignore');
      git('commit', '-qm', 'fixture baseline');
      const baseline = git('rev-parse', 'HEAD');
      const assets = ['docs/public video.mp4', 'docs/公开 [1].bin', 'docs/approved-directory/clip.mp4'];
      for (const path of assets) {
        write(filtered, path, `approved bytes: ${path}`);
        write(target, path, `approved bytes: ${path}`);
      }
      write(target, 'docs/unapproved.mp4', 'private local scratch');
      write(target, 'docs/approved-directory/local-only.mp4', 'private local scratch');
      write(target, '.env', 'LOCAL_FIXTURE=private');
      write(target, 'cat-config.json', '{}');
      write(filtered, 'cat-config.json', '{}');
      write(target, '.sync-provenance.json', JSON.stringify({ source_commit_sha: 'source-fixture' }));

      const source = readFileSync(scriptPath, 'utf8');
      const start = source.indexOf('# 5d: Auto-commit + provenance finalization');
      const end = source.indexOf('# ── Step 6: Sync summary', start);
      assert.ok(start >= 0 && end > start, 'execute the real writer commit block');
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            'target_git_repo_exists() { git -C "$1" rev-parse --git-dir >/dev/null; }',
            'CO_AUTHORS=()',
            "RUNTIME_ASSETS_ALLOWLIST=('docs/public video.mp4' 'docs/公开 [1].bin' 'docs/approved-directory/')",
            source.slice(start, end),
          ].join('\n'),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            TARGET_DIR: target,
            FILTERED_DIR: filtered,
            SOURCE_DIR: root,
            SOURCE_SHA_SHORT: 'source-fixture',
            SYNC_MODULE: 'all',
            CAT_SIG: '',
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const checkout = join(root, 'fresh');
      execFileSync('git', ['clone', '-q', '--no-local', target, checkout]);
      for (const path of assets) {
        assert.ok(existsSync(join(checkout, path)), `committed checkout must include ${path}`);
        assert.deepEqual(readFileSync(join(checkout, path)), readFileSync(join(filtered, path)));
      }
      assert.ok(!existsSync(join(checkout, 'docs/unapproved.mp4')));
      assert.ok(!existsSync(join(checkout, 'docs/approved-directory/local-only.mp4')));
      assert.ok(!existsSync(join(checkout, '.env')));
      assert.ok(!existsSync(join(checkout, 'cat-config.json')));
      assert.equal(JSON.parse(readFileSync(join(checkout, '.sync-provenance.json'))).target_head_sha, baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
