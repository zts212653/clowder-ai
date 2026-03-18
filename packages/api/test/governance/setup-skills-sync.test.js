import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SETUP_SH = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'setup.sh');

describe('setup.sh skills sync (#21)', () => {
  let content;
  it('setup.sh exists and is readable', async () => {
    content = await readFile(SETUP_SH, 'utf-8');
    assert.ok(content.length > 0);
  });

  it('contains a skills symlink creation step', async () => {
    if (!content) content = await readFile(SETUP_SH, 'utf-8');
    const hasSkillsSync =
      content.includes('cat-cafe-skills') && (content.includes('ln -s') || content.includes('ln -sf'));
    assert.ok(hasSkillsSync, 'setup.sh must create skills symlinks (cat-cafe-skills → ~/.claude/skills etc.)');
  });

  it('creates symlinks for all three providers', async () => {
    if (!content) content = await readFile(SETUP_SH, 'utf-8');
    assert.ok(content.includes('.claude/skills'), 'Must create .claude/skills symlinks');
    assert.ok(content.includes('.codex/skills'), 'Must create .codex/skills symlinks');
    assert.ok(content.includes('.gemini/skills'), 'Must create .gemini/skills symlinks');
  });
});
