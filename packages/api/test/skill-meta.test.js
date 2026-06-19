import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSkillMeta } from '../dist/skills/skill-meta.js';

describe('readSkillMeta', () => {
  it('parses requires_mcp from SKILL.md frontmatter', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'skill-meta-test-'));
    const skillDir = join(tempRoot, 'weixin-mp');

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: weixin-mp',
          'description: Publish articles through a plugin limb',
          'triggers:',
          '  - weixin',
          'requires_mcp:',
          '  - cat-cafe-limb',
          '---',
          '',
          '# Weixin MP',
        ].join('\n'),
      );

      const meta = await readSkillMeta(skillDir);

      assert.equal(meta.description, 'Publish articles through a plugin limb');
      assert.deepEqual(meta.triggers, ['weixin']);
      assert.deepEqual(meta.requiresMcp, ['cat-cafe-limb']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
