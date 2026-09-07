import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetDossierCache, loadDossierProfiles, loadDossierSnapshot } from '../dossier/load-dossier-profiles.js';
import * as parser from '../dossier/parse-dossier-profiles.js';

const good = ['```yaml', '# structured-profile: cat:good', 'entityId: "cat:good"', '```'].join('\n');
const missingIdentity = ['```yaml', '# structured-profile: cat:bad', 'oneLiner: "Incomplete record"', '```'].join('\n');
const roots: string[] = [];

afterEach(() => {
  _resetDossierCache();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical dossier parse diagnostics', () => {
  it.each([
    ['flow sequence', 'routingSignals:\n  peakCapabilities: ["reasoning"'],
    ['flow mapping', 'provenance: { version: "1"'],
    ['quoted scalar', 'oneLiner: "unterminated'],
    ['duplicate key', 'oneLiner: "first"\noneLiner: "second"'],
    ['unquoted Chinese colon', 'oneLiner: 深度推理: 系统设计'],
    ['tab indentation', 'routingSignals:\n\tpeakCapabilities: ["reasoning"]'],
    ['bare @ handle', 'handle: @bad'],
  ])('diagnoses invalid YAML %s while retaining a valid identity projection', (_label, fields) => {
    const markdown = [
      good,
      '',
      '```yaml',
      '# structured-profile: cat:bad',
      'entityId: "cat:bad"',
      'l0RoutingNote: "Review with evidence"',
      fields,
      '```',
    ].join('\n');
    const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(markdown);
    expect([...profiles.keys()]).toEqual(['good', 'bad']);
    expect(profiles.get('bad')).toMatchObject({ entityId: 'cat:bad', l0RoutingNote: 'Review with evidence' });
    expect(diagnostics).toEqual([{ catId: 'bad', reason: 'invalid_yaml', line: 7 }]);
    expect(parser.parseDossierProfiles(markdown)).toEqual(profiles);
  });

  it.each([true, false])('keeps repeated usable profiles and both diagnostics (valid first: %s)', (validFirst) => {
    const tolerant = good.replace('entityId: "cat:good"', 'entityId: "cat:good"\nhandle: @good');
    const blocks = validFirst ? [good, tolerant] : [tolerant, good];
    const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(blocks.join('\n\n'));
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([
      { catId: 'good', reason: 'invalid_yaml', line: validFirst ? 7 : 2 },
      { catId: 'good', reason: 'duplicate_profile', line: validFirst ? 7 : 8 },
    ]);
  });

  for (const tolerant of [false, true]) {
    it.each([
      true,
      false,
    ])(`retains fatal evidence without deleting the roster projection (tolerant: ${tolerant}, invalid first: %s)`, (invalidFirst) => {
      const validBad = good.replaceAll('good', 'bad');
      const projected = tolerant
        ? validBad.replace('entityId: "cat:bad"', 'entityId: "cat:bad"\nhandle: @bad')
        : validBad;
      const blocks = invalidFirst ? [missingIdentity, projected] : [projected, missingIdentity];
      const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics([good, ...blocks].join('\n\n'));
      expect([...profiles.keys()]).toEqual(['good', 'bad']);
      expect(profiles.get('bad')?.entityId).toBe('cat:bad');
      expect(diagnostics).toContainEqual({
        catId: 'bad',
        reason: 'invalid_identity',
        line: invalidFirst ? 7 : tolerant ? 13 : 12,
      });
      expect(parser.parseDossierProfiles([good, ...blocks].join('\n\n'))).toEqual(profiles);
    });
  }

  it('accepts literal brackets and backticks in valid quoted and block scalars', () => {
    const markdown = good.replace(
      'entityId: "cat:good"',
      'entityId: "cat:good"\noneLiner: "Literal [ and { and ```"\nnotes: |\n  An unmatched [ is plain text here.\n  ```',
    );
    for (const indent of ['', '  ']) {
      const indented = markdown
        .split('\n')
        .map((line) => indent + line)
        .join('\n');
      const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(indented);
      expect(profiles.get('good')?.oneLiner).toBe('Literal [ and { and ```');
      expect(diagnostics).toEqual([]);
    }
  });

  it.each([
    ['missing', '', false],
    ['malformed', 'entityId: "unterminated', false],
    ['nested', 'identity:\n  entityId: "cat:bad"', true],
    ['wrong member', 'entityId: "cat:good"', true],
  ])('reports a %s direct identity for routing while preserving the roster projection', (_label, identity, projected) => {
    const markdown = [good, '', '```yaml', '# structured-profile: cat:bad', identity, '```'].join('\n');
    const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(markdown);
    expect(profiles.has('bad')).toBe(projected);
    expect(diagnostics).toContainEqual({ catId: 'bad', reason: 'invalid_identity', line: 7 });
    expect(parser.parseDossierProfiles(markdown)).toEqual(profiles);
  });

  it.each([
    '',
    '\noneLiner: "Literal ``` data"',
  ])('reports an unterminated marked block despite inline data %s', (fields) => {
    const markdown = [good, '', '```yaml', '# structured-profile: cat:bad', `entityId: "cat:bad"${fields}`].join('\n');
    const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(markdown);
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([{ catId: 'bad', reason: 'unclosed_block', line: 7 }]);
  });

  it('ignores ordinary unmarked YAML and accepts valid CRLF profiles without diagnostics', () => {
    const markdown = ['```yaml', 'unrelated: "unterminated', '```', good].join('\n').replaceAll('\n', '\r\n');
    const { profiles, diagnostics } = parser.parseDossierProfilesWithDiagnostics(markdown);
    expect([...profiles.keys()]).toEqual(['good']);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['invalid identity', missingIdentity, 'invalid_identity', false],
    [
      'tolerated syntax',
      good.replaceAll('good', 'bad').replace('entityId: "cat:bad"', 'entityId: "cat:bad"\nhandle: @bad'),
      'invalid_yaml',
      true,
    ],
  ])('caches %s diagnostics with the projected profiles and clears them on repair', (_label, block, reason, projected) => {
    const root = mkdtempSync(join(tmpdir(), 'dossier-diagnostics-'));
    roots.push(root);
    const directory = join(root, 'docs', 'team');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'cat-dossier.md');
    writeFileSync(path, `${good}\n\n${block}`);
    const parse = vi.spyOn(parser, 'parseDossierProfilesWithDiagnostics');
    const first = loadDossierSnapshot(root);
    const cached = loadDossierSnapshot(root);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cached).toBe(first);
    expect(cached.state).toBe('loaded');
    if (cached.state !== 'loaded') throw new Error('Expected a loaded dossier snapshot');
    expect(cached.diagnostics).toEqual([{ catId: 'bad', reason, line: 7 }]);
    expect(cached.profiles.has('bad')).toBe(projected);
    expect(loadDossierProfiles(root)).toBe(first.profiles);
    expect(parse).toHaveBeenCalledTimes(1);
    writeFileSync(path, `${good}\n\n${good.replaceAll('good', 'bad')}`);
    const repaired = loadDossierSnapshot(root);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(repaired.state).toBe('loaded');
    expect(repaired.profiles.has('bad')).toBe(true);
    expect(repaired).toMatchObject({ diagnostics: [] });
  });
});
