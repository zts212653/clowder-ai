import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfileEntries } from '../profile-frontmatter-parser.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('F243 profile frontmatter parser', () => {
  it('loads a valid human-authored profile entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const file = writeFile(
        root,
        'docs/features/F999-test.md',
        [
          '---',
          'feature_ids: [F999]',
          'topics: [docs, discovery]',
          'description: Stable knowledge entry point',
          'description_source: human',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '',
          '# F999: Test Feature',
          '',
          'Body',
        ].join('\n'),
      );

      const result = loadProfileEntries([file]);
      expect(result.diagnostics).toEqual([]);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        path: file,
        title_h1: 'F999: Test Feature',
        description: 'Stable knowledge entry point',
        description_source: 'human',
        description_author: 'codex',
        description_updated_at: '2026-06-30T12:00:00Z',
        topics: ['docs', 'discovery'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates model provenance fields and imported reserve status', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const modelFile = writeFile(
        root,
        'docs/features/F998-model.md',
        [
          '---',
          'description: Model generated description',
          'description_source: model',
          'description_author: opus-47',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F998: Model',
        ].join('\n'),
      );
      const importedFile = writeFile(
        root,
        'docs/features/F997-imported.md',
        [
          '---',
          'description: Imported description',
          'description_source: imported',
          'description_author: codex',
          'description_updated_at: 2026-06-30T12:00:00Z',
          '---',
          '# F997: Imported',
        ].join('\n'),
      );

      const result = loadProfileEntries([modelFile, importedFile]);
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
      expect(codes).toEqual([
        'f243/imported-reserved-until-defined',
        'f243/model-provenance-missing',
        'f243/model-provenance-missing',
        'f243/model-provenance-missing',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the SKILL.md compatibility profile without forcing epistemic fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const skillFile = writeFile(
        root,
        'cat-cafe-skills/example/SKILL.md',
        ['---', 'name: example', 'description: Example skill stable identity', '---', '# Example Skill'].join('\n'),
      );

      const result = loadProfileEntries([skillFile]);
      expect(result.diagnostics).toEqual([]);
      expect(result.entries[0]).toMatchObject({
        description: 'Example skill stable identity',
        skill_compat_profile: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates provided SKILL.md provenance fields inside the compatibility profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const modelSkillFile = writeFile(
        root,
        'cat-cafe-skills/model-skill/SKILL.md',
        [
          '---',
          'name: model-skill',
          'description: Model-authored skill description',
          'description_source: model',
          '---',
          '# Model Skill',
        ].join('\n'),
      );
      const importedSkillFile = writeFile(
        root,
        'cat-cafe-skills/imported-skill/SKILL.md',
        [
          '---',
          'name: imported-skill',
          'description: Imported skill description',
          'description_source: imported',
          '---',
          '# Imported Skill',
        ].join('\n'),
      );

      const result = loadProfileEntries([modelSkillFile, importedSkillFile]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
        'f243/imported-reserved-until-defined',
        'f243/model-provenance-missing',
        'f243/model-provenance-missing',
        'f243/model-provenance-missing',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates model-generated timestamps as ISO dates', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const file = writeFile(
        root,
        'docs/features/F996-model-generated-at.md',
        [
          '---',
          'description: Model generated description',
          'description_source: model',
          'description_author: opus-47',
          'description_updated_at: 2026-06-30T12:00:00Z',
          'description_generated_by: tiny-model',
          'description_generated_at: not-a-date',
          'description_confirmed_by: codex',
          '---',
          '# F996: Model Generated At',
        ].join('\n'),
      );

      const result = loadProfileEntries([file]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'f243/invalid-description-generated-at',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps SKILL.md description shape enforcement inside the compatibility profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'f243-profile-parser-'));
    try {
      const skillFile = writeFile(
        root,
        'cat-cafe-skills/example/SKILL.md',
        [
          '---',
          'name: example',
          `description: ${'Long skill description. '.repeat(12)}`,
          '---',
          '# Example Skill',
        ].join('\n'),
      );

      const result = loadProfileEntries([skillFile]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['f243/description-too-long']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
