import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _resetDossierCache, loadDossierProfiles, loadDossierSnapshot } from '../dossier/load-dossier-profiles.js';
import { parseDossierProfilesWithDiagnostics } from '../dossier/parse-dossier-profiles.js';

const roots: string[] = [];
const valid = '```yaml\n# structured-profile: cat:fixture\nentityId: "cat:fixture"\noneLiner: "valid"\n```\n';
afterEach(() => {
  _resetDossierCache();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dossier read snapshots', () => {
  test('separates absence, read errors and loaded content; repairs invalidate cached health', () => {
    const root = mkdtempSync(join(tmpdir(), 'dossier-snapshot-'));
    roots.push(root);
    const path = join(root, 'docs/team/cat-dossier.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadDossierSnapshot(root).state).toBe('absent');
    expect(warn).not.toHaveBeenCalled();
    mkdirSync(path, { recursive: true });
    expect(loadDossierSnapshot(root)).toMatchObject({ state: 'unreadable', errorCode: 'EISDIR' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[F208 KD-9]'));
    rmSync(path, { recursive: true });
    writeFileSync(path, valid);
    const loaded = loadDossierSnapshot(root);
    expect(loaded).toMatchObject({ state: 'loaded', diagnostics: [] });
    expect(loadDossierSnapshot(root)).toBe(loaded);
    expect(loadDossierProfiles(root)).toBe(loaded.profiles);
    writeFileSync(path, `${valid}\`\`\`yaml\n# structured-profile: cat:broken\noneLiner: "no identity"\n\`\`\`\n`);
    expect(loadDossierSnapshot(root)).toMatchObject({
      state: 'loaded',
      diagnostics: [{ catId: 'broken', reason: 'invalid_identity' }],
    });
    expect(loadDossierProfiles(root).get('fixture')?.oneLiner).toBe('valid');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    const warningCount = warn.mock.calls.length;
    loadDossierSnapshot(root);
    expect(warn).toHaveBeenCalledTimes(warningCount);
    writeFileSync(path, valid);
    expect(loadDossierSnapshot(root)).toMatchObject({ state: 'loaded', diagnostics: [] });
    rmSync(path);
    expect(loadDossierSnapshot(root).state).toBe('absent');
  });

  test('canonical dossier produces no syntax or identity diagnostics', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const snapshot = loadDossierSnapshot(root);
    expect(snapshot).toMatchObject({ state: 'loaded', diagnostics: [] });
    expect(snapshot.profiles.size).toBeGreaterThan(0);
  });
});

describe('canonical parser diagnostic projection', () => {
  test('unmarked markdown YAML is not a profile failure', () => {
    expect(parseDossierProfilesWithDiagnostics(`${valid}\`\`\`yaml\nexample: [\n\`\`\`\n`).diagnostics).toEqual([]);
  });

  test.each([
    ['invalid_yaml', valid.replace('entityId:', 'broken: [\nentityId:')],
    ['invalid_identity', valid.replace('entityId: "cat:fixture"', 'entityId: "cat:wrong"')],
    ['invalid_identity', valid.replace('entityId: "cat:fixture"\n', '')],
    ['unclosed_block', valid.slice(0, -4)],
    ['duplicate_profile', valid + valid],
  ])('%s is observable beside surviving valid profiles', (reason, broken) => {
    const parsed = parseDossierProfilesWithDiagnostics(broken);
    expect(parsed.diagnostics).toContainEqual({
      catId: 'fixture',
      reason,
      line: reason === 'duplicate_profile' ? 7 : 2,
    });
  });

  test('supports CRLF blocks without changing the canonical field projection', () => {
    const parsed = parseDossierProfilesWithDiagnostics(valid.replaceAll('\n', '\r\n'));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.profiles.get('fixture')?.oneLiner).toBe('valid');
  });
});
