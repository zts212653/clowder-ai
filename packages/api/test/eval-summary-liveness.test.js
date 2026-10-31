import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEnrichedEvalHubSummary } from '../dist/infrastructure/harness-eval/hub/eval-hub-summary-service.js';

test(
  'R07: full artifact projection and slow worktree discovery leave timers responsive',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-summary-liveness-'));
    const oldPath = process.env.PATH;
    try {
      const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
      await mkdir(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
      await mkdir(join(harnessFeedbackRoot, 'eval-domains'));
      await mkdir(join(root, 'bin'));
      const git = join(root, 'bin/git');
      await writeFile(
        git,
        `#!${process.execPath}\nsetTimeout(() => console.log('worktree ${root}\\nHEAD ${'a'.repeat(40)}\\nbranch refs/heads/main\\n'), 400);\n`,
      );
      await chmod(git, 0o755);
      process.env.PATH = `${join(root, 'bin')}:${oldPath}`;
      const started = performance.now();
      let firstTick = Infinity;
      const timer = setTimeout(() => {
        firstTick = performance.now() - started;
      }, 5);
      const options = { harnessFeedbackRoot, userId: 'owner', log: { warn: () => {} } };
      const [a, b] = await Promise.all([loadEnrichedEvalHubSummary(options), loadEnrichedEvalHubSummary(options)]);
      clearTimeout(timer);
      assert.ok(firstTick < 250, `summary monopolized the API loop for ${firstTick} ms`);
      assert.equal(a.counts.total, 0);
      assert.notEqual(a, b, 'caller-specific enrichment cannot share a mutable projection');
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
