import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCatCafeSkillsSource } from '../../dist/utils/skill-source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');

describe('Cat Cafe skills source resolver', () => {
  test('uses the current worktree root instead of the primary worktree', async () => {
    assert.equal(await resolveCatCafeSkillsSource(), join(repoRoot, 'cat-cafe-skills'));
  });

  test('does not route lifecycle skill source through resolveMainRepoPath', async () => {
    const resolverSource = await readFile(join(repoRoot, 'packages/api/src/utils/skill-source.ts'), 'utf-8');
    assert.doesNotMatch(resolverSource, /resolveMainRepoPath/);
  });

  test('skills-drift route uses the shared resolver instead of a startup-root constant', async () => {
    const routeSource = await readFile(join(repoRoot, 'packages/api/src/routes/skills-drift.ts'), 'utf-8');
    assert.match(routeSource, /resolveCatCafeSkillsSource/);
    assert.doesNotMatch(routeSource, /const\s+SKILLS_SOURCE\s*=/);
  });
});
