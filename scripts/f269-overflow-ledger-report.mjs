import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

function collectReportGroups(ledger) {
  const classified = ledger.records.filter((record) => record.disposition === 'classified');
  const offenderCounts = new Map();
  const ownerCounts = new Map();
  for (const record of classified) {
    offenderCounts.set(record.path, (offenderCounts.get(record.path) ?? 0) + 1);
    const counts = ownerCounts.get(record.owner) ?? { total: 0, U0: 0, U1: 0, U2: 0, U3: 0, U4: 0 };
    counts.total += 1;
    counts[record.severity] += 1;
    ownerCounts.set(record.owner, counts);
  }
  const topOffenders = [...offenderCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10);
  const severityOrder = new Map([
    ['U0', 0],
    ['U1', 1],
    ['U2', 2],
  ]);
  const migrationQueue = classified
    .filter((record) => severityOrder.has(record.severity))
    .sort(
      (left, right) =>
        severityOrder.get(left.severity) - severityOrder.get(right.severity) ||
        left.path.localeCompare(right.path) ||
        left.line - right.line,
    );
  const physicalProducers = ledger.records
    .filter((record) => record.sourceKind === 'physical-producer')
    .sort(
      (left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.id.localeCompare(right.id),
    );
  const owners = [...ownerCounts.entries()].sort(
    (left, right) => right[1].total - left[1].total || left[0].localeCompare(right[0]),
  );
  return { migrationQueue, owners, physicalProducers, topOffenders };
}

export function renderMarkdownReport(ledger) {
  const { metadata, coverage } = ledger;
  const { migrationQueue, owners, physicalProducers, topOffenders } = collectReportGroups(ledger);
  const lines = [
    '---',
    'feature_ids: [F269]',
    'related_features: [F056, F255]',
    'topics: [frontend, ux, content-overflow, audit, accessibility]',
    'doc_kind: note',
    'description: "F269 full-frontend Overflow Ledger and current severity snapshot."',
    'description_source: model',
    'description_generated_by: codex-sol@gpt-5.6-sol',
    `description_generated_at: ${metadata.generatedAt}`,
    'description_confirmed_by: codex-sol',
    'description_author: codex-sol',
    `description_updated_at: ${metadata.generatedAt}`,
    '---',
    '',
    '# F269 Phase A Overflow Ledger',
    '',
    `- auditBaseSha: \`${metadata.auditBaseSha}\``,
    `- auditSourceFingerprint: \`${metadata.auditSourceFingerprint}\``,
    `- auditFreshnessRef: \`${metadata.auditFreshnessRef}\``,
    `- scannerVersion: \`${metadata.scannerVersion}\``,
    `- scannerCommand: \`${metadata.scannerCommand}\``,
    '',
    '## Coverage',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Raw lexical files | ${coverage.rawLexicalFiles} |`,
    `| Raw lexical matches | ${coverage.rawLexicalMatches} |`,
    `| Text token files | ${coverage.textTokenFiles} |`,
    `| Text token matches | ${coverage.textTokenMatches} |`,
    `| Physical producer records | ${coverage.physicalProducerRecords} |`,
    `| Classified records | ${coverage.classifiedRecords} |`,
    `| Explicit exclusions | ${coverage.excludedRecords} |`,
    '',
    '### Coverage equations',
    '',
    `- Raw lexical: ${coverage.rawLexicalMatches} = ${coverage.classifiedCssMatches} classified + ${coverage.explicitlyExcludedLexicalMatches} excluded matches.`,
    `- Text tokens: ${coverage.textTokenMatches} = ${coverage.classifiedTextTokenMatches} classified + ${coverage.explicitlyExcludedTextTokenMatches} excluded matches.`,
    `- Inventory: ${coverage.inventoryRecords} = ${coverage.classifiedRecords} classified + ${coverage.excludedRecords} excluded records.`,
    `- Classified: ${coverage.classifiedRecords} = ${Object.entries(coverage.bySeverity)
      .map(([severity, count]) => `${severity} ${count}`)
      .join(' + ')}.`,
    '',
    '### Classification conventions',
    '',
    '- A record represents one user-visible field or one physical producer contract; `lexicalMatchCount` preserves cases where one field contains multiple matched tokens.',
    '- A match is one raw source occurrence. Coverage equations keep match counts separate from record counts so lexical density cannot hide or inflate user-facing debt.',
    '- `targetPattern: retain` means the existing presentation needs no migration. A compliant U3 record can still name its semantic pattern when later consolidation needs that mapping.',
    '- `callback-anchor-helpers.ts` is a positive producer contract: its preview slices declare truncation and return one-hop drill metadata to canonical content.',
    '- The producer set covers reviewed user-visible text previews and does not claim that every source `.slice()` is content overflow; array windowing, parsing, and structural transforms stay outside this ledger.',
    '',
    '## Severity',
    '',
    '| Severity | Records |',
    '|---|---:|',
    ...Object.entries(coverage.bySeverity).map(([severity, count]) => `| ${severity} | ${count} |`),
    '',
    '### Owner distribution',
    '',
    '| Owner | Classified | U0 | U1 | U2 | U3 | U4 |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...(owners.length > 0
      ? owners.map(
          ([owner, counts]) =>
            `| ${markdownCell(owner)} | ${counts.total} | ${counts.U0} | ${counts.U1} | ${counts.U2} | ${counts.U3} | ${counts.U4} |`,
        )
      : ['| None | 0 | 0 | 0 | 0 | 0 | 0 |']),
    '',
    '## Physical producer coverage',
    '',
    '| Locator | Status | Field | Stage | Recovery | Owner | Source |',
    '|---|---|---|---|---|---|---|',
    ...(physicalProducers.length > 0
      ? physicalProducers.map(
          (record) =>
            `| \`${record.id}\` | ${record.disposition === 'excluded' ? 'excluded' : record.severity} | ${markdownCell(record.field)} | ${record.truncationStage} | ${markdownCell(record.currentRecovery.join(', ') || 'none')} | ${markdownCell(record.owner)} | \`${record.path}:${record.line}\` |`,
        )
      : ['| None | - | - | - | - | - | - |']),
    '',
    '## Top offenders',
    '',
    '| Source file | Classified records |',
    '|---|---:|',
    ...(topOffenders.length > 0 ? topOffenders.map(([path, count]) => `| \`${path}\` | ${count} |`) : ['| None | 0 |']),
    '',
    '## Migration queue',
    '',
    '| Severity | Surface | Field | Current recovery | Target | Source |',
    '|---|---|---|---|---|---|',
    ...(migrationQueue.length > 0
      ? migrationQueue.map(
          (record) =>
            `| ${record.severity} | ${markdownCell(record.surface)} | ${markdownCell(record.field)} | ${markdownCell(record.currentRecovery.join(', ') || 'none')} | ${record.targetPattern} | \`${record.path}:${record.line}\` |`,
        )
      : ['| - | - | - | - | - | - |']),
    '',
    '## Representative screenshots',
    '',
    ...(metadata.screenshots?.length > 0
      ? metadata.screenshots.flatMap((shot) => [
          `### ${shot.title}`,
          '',
          `![${markdownCell(shot.alt)}](${shot.path})`,
          '',
          `- Ledger record: \`${shot.recordId}\``,
          `- Viewport: \`${shot.viewport}\``,
          `- Reproduction: ${shot.reproduction}`,
          '',
        ])
      : [metadata.screenshotNote ?? 'No screenshot fixtures recorded.', '']),
    '## Full ledger',
    '',
    '| Severity | Surface | Component / field | Stage | Full content | Recovery | Target | Owner | Source | Rationale |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const record of ledger.records) {
    lines.push(
      `| ${record.disposition === 'excluded' ? 'excluded' : record.severity} | ${markdownCell(record.surface)} | ${markdownCell(`${record.component} / ${record.field}`)} | ${record.truncationStage} | ${record.fullContentAvailability} | ${markdownCell(record.currentRecovery.join(', ') || 'none')} | ${record.targetPattern} | ${markdownCell(record.owner)} | \`${record.path}:${record.line}\` | ${markdownCell(record.rationale)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function buildArtifactContents(ledger) {
  return {
    json: `${JSON.stringify(ledger, null, 2)}\n`,
    markdown: renderMarkdownReport(ledger),
  };
}

export function assertArtifactContentsCurrent({ artifacts, paths }) {
  const stale = [];
  for (const kind of ['json', 'markdown']) {
    const artifactPath = paths[kind];
    if (!existsSync(artifactPath) || readFileSync(artifactPath, 'utf8') !== artifacts[kind]) {
      stale.push(basename(artifactPath));
    }
  }
  if (stale.length > 0) throw new Error(`generated overflow artifacts are stale: ${stale.join(', ')}`);
}

export function writeArtifactContents({ artifacts, paths }) {
  mkdirSync(dirname(paths.json), { recursive: true });
  mkdirSync(dirname(paths.markdown), { recursive: true });
  writeFileSync(paths.json, artifacts.json);
  writeFileSync(paths.markdown, artifacts.markdown);
}
