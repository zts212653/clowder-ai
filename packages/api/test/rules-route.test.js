import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

function findProjectRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

describe('rules route data sources', () => {
  const root = findProjectRoot();

  it('shared-rules.md exists at expected path', () => {
    assert.ok(existsSync(join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md')));
  });

  it('SOP.md exists at expected path', () => {
    assert.ok(existsSync(join(root, 'docs', 'SOP.md')));
  });

  it('provider guide files exist', () => {
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      assert.ok(existsSync(join(root, file)), `${file} should exist`);
    }
  });

  it('cat-cafe-skills directory has SKILL.md files', () => {
    const skillsDir = join(root, 'cat-cafe-skills');
    assert.ok(existsSync(skillsDir), 'cat-cafe-skills directory should exist');
    const qualityGateSkill = join(skillsDir, 'quality-gate', 'SKILL.md');
    assert.ok(existsSync(qualityGateSkill), 'quality-gate/SKILL.md should exist');
  });

  it('rejects path traversal in skill name', () => {
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('../etc'));
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('foo/bar'));
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('.hidden'));
    assert.ok(/^[a-z][a-z0-9-]*$/i.test('quality-gate'));
    assert.ok(/^[a-z][a-z0-9-]*$/i.test('tdd'));
  });
});
