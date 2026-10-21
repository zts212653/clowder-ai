import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import catalog from '../../../../public/avatars/family/catalog.json';

const root = resolve(__dirname, '../../../../../..');
const approvedIds = [
  'opus55',
  'opus5',
  'opus-47',
  'fable-5',
  'sonnet',
  'opus',
  'opus-45',
  'codex61-sol',
  'codex6-sol',
  'codex-sol',
  'codex-astra',
  'codex-luna',
  'codex6-luna',
  'codex-terra',
  'gpt-pro',
  'codex',
  'spark',
  'gemini38',
  'gemini',
  'gemini25',
  'kimi',
  'dsh',
  'glm52',
  'antigravity',
  'antig-opus',
  'opencode',
];
describe('approved family assets remain portable release inputs', () => {
  it('contains the accepted used avatars and excludes unused/test additions', () => {
    expect(catalog.map((a) => a.id)).toEqual(approvedIds);
    expect(new Set(catalog.map((a) => a.src)).size).toBe(26);
    expect(catalog.some((a) => a.src.startsWith('/uploads/'))).toBe(false);
  });
  it('ships every chooser and role-template asset through the existing export roots', () => {
    const manifestPath = resolve(root, 'sync-manifest.yaml');
    const manifest = existsSync(manifestPath)
      ? (YAML.parse(readFileSync(manifestPath, 'utf8')) as {
          managed_roots: string[];
          managed_files: string[];
          excluded: string[];
        })
      : null;
    const templates = JSON.parse(readFileSync(resolve(root, 'cat-template.json'), 'utf8')) as {
      roleTemplates: Array<{ id: string; avatar: string; defaultModel?: string; clientId?: string }>;
    };
    if (manifest) expect(manifest.managed_files).toContain('cat-template.json');
    const roles = new Set(templates.roleTemplates.map((t) => t.id));
    for (const a of catalog) {
      expect(roles.has(a.roleTemplateId), a.id).toBe(true);
      const repoPath = `packages/web/public${a.src}`;
      if (manifest) {
        expect(
          manifest.managed_roots.some((p) => repoPath.startsWith(`${p}/`)),
          repoPath,
        ).toBe(true);
        expect(manifest.excluded).not.toContain(repoPath);
      }
      const file = resolve(root, repoPath);
      expect(statSync(file).size).toBeGreaterThan(0);
      expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
    }
    for (const role of templates.roleTemplates) {
      expect(role.defaultModel).toBeUndefined();
      expect(role.clientId).toBeUndefined();
      expect(statSync(resolve(root, `packages/web/public${role.avatar}`)).size).toBeGreaterThan(0);
    }
    expect(templates.roleTemplates.find((t) => t.id === 'turkish-van')?.avatar).toBe('/avatars/family/kimi.png');
  });
  it('keeps Momo’s recorded Turkish Van breed in the portable catalog', () => {
    // Canonical family identity: docs/stories/cat-names/README.md, “墨墨 — 梵花猫 Turkish Van”.
    const momo = catalog.find((avatar) => avatar.id === 'kimi');
    expect(momo?.breed).toBe('turkish-van');
    expect(momo?.roleTemplateId).toBe('turkish-van');
  });
});
