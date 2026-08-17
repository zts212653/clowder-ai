import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { SHARED_SKILL_REFS_ALIAS, scanSkillReferenceGraph } from './check-skill-reference-integrity.mjs';

function fixture(reference) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'skill-ref-integrity-'));
  const skillsRoot = join(repoRoot, 'cat-cafe-skills');
  mkdirSync(join(skillsRoot, 'refs'), { recursive: true });
  mkdirSync(join(skillsRoot, 'sample'), { recursive: true });
  writeFileSync(join(skillsRoot, 'refs', 'guide.md'), '# guide\n');
  writeFileSync(join(skillsRoot, 'sample', 'SKILL.md'), `Read ${reference}.\n`);
  return { repoRoot, skillsRoot };
}

describe('check-skill-reference-integrity', () => {
  it('rejects shared refs that depend on the skill entry depth', () => {
    const { repoRoot } = fixture('[guide](../refs/guide.md)');
    const result = scanSkillReferenceGraph(repoRoot);
    assert.ok(result.findings.some((finding) => finding.code === 'unstable-shared-reference'));
  });

  it('accepts the reserved shared refs coordinate when it resolves to the canonical directory', () => {
    const { repoRoot, skillsRoot } = fixture(`[guide](../${SHARED_SKILL_REFS_ALIAS}/guide.md)`);
    symlinkSync('refs', join(skillsRoot, SHARED_SKILL_REFS_ALIAS));
    assert.deepEqual(scanSkillReferenceGraph(repoRoot), { findings: [], sharedReferenceCount: 1 });
  });

  it('resolves the same declaration from a runtime per-skill entry', () => {
    const { repoRoot, skillsRoot } = fixture(`[guide](../${SHARED_SKILL_REFS_ALIAS}/guide.md)`);
    symlinkSync('refs', join(skillsRoot, SHARED_SKILL_REFS_ALIAS));
    const runtimeSkills = join(repoRoot, '.codex', 'skills');
    mkdirSync(runtimeSkills, { recursive: true });
    symlinkSync(resolve(skillsRoot, 'sample'), join(runtimeSkills, 'sample'));
    symlinkSync(resolve(skillsRoot, 'refs'), join(runtimeSkills, SHARED_SKILL_REFS_ALIAS));

    const runtimeSkillFile = join(runtimeSkills, 'sample', 'SKILL.md');
    const runtimeTarget = resolve(dirname(runtimeSkillFile), `../${SHARED_SKILL_REFS_ALIAS}/guide.md`);
    assert.equal(realpathSync(runtimeTarget), realpathSync(join(skillsRoot, 'refs', 'guide.md')));
  });

  it('rejects a stable coordinate whose target file is missing', () => {
    const { repoRoot, skillsRoot } = fixture(`[missing](../${SHARED_SKILL_REFS_ALIAS}/missing.md)`);
    symlinkSync('refs', join(skillsRoot, SHARED_SKILL_REFS_ALIAS));
    const result = scanSkillReferenceGraph(repoRoot);
    assert.ok(result.findings.some((finding) => finding.code === 'missing-shared-reference'));
  });

  it('keeps skill-local refs local', () => {
    const { repoRoot, skillsRoot } = fixture('[local](refs/local.md)');
    mkdirSync(join(skillsRoot, 'sample', 'refs'));
    writeFileSync(join(skillsRoot, 'sample', 'refs', 'local.md'), '# local\n');
    symlinkSync('refs', join(skillsRoot, SHARED_SKILL_REFS_ALIAS));
    assert.deepEqual(scanSkillReferenceGraph(repoRoot), { findings: [], sharedReferenceCount: 0 });
  });

  it('detects inline-code declarations that name a shared ref from the wrong coordinate', () => {
    const { repoRoot, skillsRoot } = fixture('`refs/guide.md`');
    symlinkSync('refs', join(skillsRoot, SHARED_SKILL_REFS_ALIAS));
    const result = scanSkillReferenceGraph(repoRoot);
    assert.ok(result.findings.some((finding) => finding.code === 'unstable-shared-reference'));
  });
});
