import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs = [];

export function makeRepo() {
  const rootDir = mkdtempSync(join(tmpdir(), 'f269-ledger-'));
  tempDirs.push(rootDir);
  mkdirSync(join(rootDir, 'packages', 'web', 'src', '__tests__'), { recursive: true });
  mkdirSync(join(rootDir, 'packages', 'api', 'src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages', 'web', 'src', 'Card.tsx'),
    [
      'export function Card({ reason, name, value }) {',
      '  const preview = truncate(value);',
      '  return <p className="line-clamp-1 group-hover:line-clamp-none">{reason}</p>;',
      '  return <span className={`truncate $' + '{name}`}>{name}</span>;',
      '  return <span className="truncate">',
      '    {value}',
      '  </span>;',
      '  return (',
      '    <span',
      '      className={`',
      '        truncate flex-1 ${',
      "        name ? 'named' : ''",
      '      }`}',
      '    >',
      '      {value}',
      '    </span>',
      '  );',
      '  return <ExpandableText',
      '    text={reason}',
      '    clampClass="line-clamp-2"',
      '  />;',
      '}',
      '// truncate is mentioned in a comment',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(rootDir, 'packages', 'web', 'src', '__tests__', 'Card.test.tsx'),
    'it("renders truncate", () => {});\n',
  );
  writeFileSync(
    join(rootDir, 'packages', 'api', 'src', 'preview.ts'),
    ['export function preview(text) {', '  return text.slice(0, 80);', '}', ''].join('\n'),
  );
  return rootDir;
}

export function classified(id, overrides = {}) {
  return {
    id,
    disposition: 'classified',
    surface: 'test surface',
    component: 'Card',
    field: 'reason',
    contentKind: 'prose',
    truncationStage: 'css-clamp',
    fullContentAvailability: 'current-dom',
    currentRecovery: ['none'],
    inputCoverage: { mouse: false, keyboard: false, touch: false, screenReader: false },
    severity: 'U1',
    targetPattern: 'expandable-prose',
    owner: 'hub-action-surface',
    rationale: 'Full prose exists but the fixture has no recovery control.',
    ...overrides,
  };
}

export function excluded(id) {
  return {
    id,
    disposition: 'excluded',
    exclusionReason: 'Lexical test or helper noise with no user-visible content.',
    surface: 'not applicable',
    component: 'not applicable',
    field: 'not applicable',
    contentKind: 'non-content',
    truncationStage: 'not-applicable',
    fullContentAvailability: 'not-applicable',
    currentRecovery: [],
    inputCoverage: { mouse: false, keyboard: false, touch: false, screenReader: false },
    targetPattern: 'exclude',
    owner: 'hub-action-surface',
    rationale: 'Excluded from user-visible overflow classification.',
  };
}

export function metadata() {
  return {
    auditBaseSha: 'a'.repeat(40),
    auditSourceFingerprint: 'b'.repeat(64),
    auditFreshnessRef: 'origin/main',
    scannerVersion: 'f269-phase-a-v2',
    scannerCommand: 'pnpm audit:f269-overflow -- --check',
    generatedAt: '2026-07-19T00:00:00Z',
  };
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
