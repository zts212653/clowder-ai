import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildLedger,
  materializeClassifications,
  scanCssLexical,
  scanPhysicalProducers,
} from './f269-overflow-ledger.mjs';
import { classified, cleanupTempDirs, excluded, makeRepo, metadata } from './f269-overflow-ledger-test-fixtures.mjs';

afterEach(cleanupTempDirs);

describe('F269 overflow ledger scanner', () => {
  it('keeps the raw lexical denominator while grouping text tokens by source line', () => {
    const rootDir = makeRepo();
    const scan = scanCssLexical({ rootDir });

    assert.equal(scan.rawLexicalMatches, 9);
    assert.equal(scan.rawLexicalFiles, 2);
    assert.equal(scan.textTokenMatches, 6);
    assert.equal(scan.textTokenFiles, 1);

    const multiToken = scan.records.find((record) => record.sourceToken.includes('line-clamp-1'));
    assert.ok(multiToken);
    assert.equal(multiToken.lexicalMatchCount, 2);
    assert.deepEqual(multiToken.textTokens, ['line-clamp-1', 'line-clamp-none']);

    const multiline = scan.records.find((record) => record.line === 5);
    const multilineTemplate = scan.records.find((record) => record.sourceExcerpt.includes('truncate flex-1 ${'));
    const propDriven = scan.records.find((record) => record.sourceToken === 'line-clamp-2');
    assert.equal(multiline?.fieldHint, 'value');
    assert.equal(multilineTemplate?.candidateKind, 'text-token');
    assert.equal(multilineTemplate?.fieldHint, 'value');
    assert.equal(propDriven?.fieldHint, 'reason');

    const testNoise = scan.records.find((record) => record.path.endsWith('Card.test.tsx'));
    assert.ok(testNoise);
    assert.equal(testNoise.candidateKind, 'lexical-noise');
  });

  it('fails closed when a physical producer locator is missing or ambiguous', () => {
    const rootDir = makeRepo();
    const locators = [
      {
        id: 'producer:preview',
        path: 'packages/api/src/preview.ts',
        needles: ['return text.slice(0, 80);'],
      },
    ];

    const records = scanPhysicalProducers({ rootDir, locators });
    assert.equal(records.length, 1);
    assert.equal(records[0].line, 2);

    assert.throws(
      () =>
        scanPhysicalProducers({
          rootDir,
          locators: [{ id: 'producer:missing', path: 'packages/api/src/preview.ts', needles: ['not present'] }],
        }),
      /expected exactly one match/i,
    );
    assert.throws(
      () =>
        scanPhysicalProducers({
          rootDir,
          locators: [{ id: 'producer:ambiguous', path: 'packages/api/src/preview.ts', needles: ['text'] }],
        }),
      /expected exactly one match/i,
    );
  });

  it('requires an exact classification join and proves all coverage equations', () => {
    const rootDir = makeRepo();
    const cssScan = scanCssLexical({ rootDir });
    const producerRecords = scanPhysicalProducers({
      rootDir,
      locators: [
        {
          id: 'producer:preview',
          path: 'packages/api/src/preview.ts',
          needles: ['return text.slice(0, 80);'],
        },
      ],
    });
    const classifications = [
      ...cssScan.records.map((record) =>
        record.candidateKind === 'text-token' ? classified(record.id) : excluded(record.id),
      ),
      classified('producer:preview', {
        component: 'preview',
        field: 'preview text',
        truncationStage: 'api-preview',
        fullContentAvailability: 'permanently-lost',
        severity: 'U0',
        targetPattern: 'critical-text',
      }),
    ];

    const ledger = buildLedger({ metadata: metadata(), cssScan, producerRecords, classifications });

    assert.equal(ledger.coverage.rawLexicalMatches, 9);
    assert.equal(
      ledger.coverage.rawLexicalMatches,
      ledger.coverage.classifiedCssMatches + ledger.coverage.explicitlyExcludedLexicalMatches,
    );
    assert.equal(ledger.coverage.inventoryRecords, ledger.coverage.classifiedRecords + ledger.coverage.excludedRecords);
    assert.equal(
      ledger.coverage.classifiedRecords,
      Object.values(ledger.coverage.bySeverity).reduce((sum, count) => sum + count, 0),
    );

    assert.throws(
      () => buildLedger({ metadata: metadata(), cssScan, producerRecords, classifications: classifications.slice(1) }),
      /missing classification/i,
    );
    assert.throws(
      () =>
        buildLedger({
          metadata: metadata(),
          cssScan,
          producerRecords,
          classifications: [...classifications, { ...classifications[0] }],
        }),
      /duplicate classification/i,
    );
    assert.throws(
      () =>
        buildLedger({
          metadata: metadata(),
          cssScan,
          producerRecords,
          classifications: [...classifications, excluded('css:stale:1')],
        }),
      /stale classification/i,
    );
    const wrongStage = classifications.map((record) =>
      record.id === 'producer:preview' ? { ...record, truncationStage: 'css-clamp' } : record,
    );
    assert.throws(
      () => buildLedger({ metadata: metadata(), cssScan, producerRecords, classifications: wrongStage }),
      /physical producer.*css-clamp/i,
    );
  });

  it('materializes reviewed profiles and auto-excludes only lexical noise', () => {
    const rootDir = makeRepo();
    const cssScan = scanCssLexical({ rootDir });
    const producerRecords = scanPhysicalProducers({
      rootDir,
      locators: [
        {
          id: 'producer:preview',
          path: 'packages/api/src/preview.ts',
          needles: ['return text.slice(0, 80);'],
        },
      ],
    });
    const actionable = [...cssScan.records, ...producerRecords].filter(
      (record) => record.candidateKind !== 'lexical-noise',
    );
    const config = {
      profiles: {
        'u1-prose-none': {
          disposition: 'classified',
          contentKind: 'prose',
          truncationStage: 'css-clamp',
          fullContentAvailability: 'current-dom',
          currentRecovery: ['none'],
          inputCoverage: { mouse: false, keyboard: false, touch: false, screenReader: false },
          severity: 'U1',
          targetPattern: 'expandable-prose',
          owner: 'hub-action-surface',
          rationale: 'Reviewed fixture prose has no recovery control.',
        },
      },
      assignments: Object.fromEntries(actionable.map((record) => [record.id, 'u1-prose-none'])),
    };

    const classifications = materializeClassifications({ cssScan, producerRecords, config });
    assert.equal(classifications.length, cssScan.records.length + producerRecords.length);
    assert.equal(
      classifications.filter((record) => record.disposition === 'excluded').length,
      cssScan.records.filter((record) => record.candidateKind === 'lexical-noise').length,
    );
    assert.ok(classifications.every((record) => record.surface && record.component && record.field));

    const missingConfig = structuredClone(config);
    delete missingConfig.assignments[actionable[0].id];
    assert.throws(
      () => materializeClassifications({ cssScan, producerRecords, config: missingConfig }),
      /missing assignment/i,
    );

    const staleConfig = structuredClone(config);
    staleConfig.assignments['css:stale:1'] = 'u1-prose-none';
    assert.throws(
      () => materializeClassifications({ cssScan, producerRecords, config: staleConfig }),
      /stale assignment/i,
    );

    const groupedConfig = {
      profiles: config.profiles,
      assignmentGroups: [{ profile: 'u1-prose-none', ids: actionable.map((record) => record.id) }],
    };
    assert.equal(
      materializeClassifications({ cssScan, producerRecords, config: groupedConfig }).length,
      cssScan.records.length + producerRecords.length,
    );
    groupedConfig.assignmentGroups.push({ profile: 'u1-prose-none', ids: [actionable[0].id] });
    assert.throws(
      () => materializeClassifications({ cssScan, producerRecords, config: groupedConfig }),
      /duplicate assignment/i,
    );

    const baselineConfig = {
      profiles: config.profiles,
      baselineProfile: 'u1-prose-none',
      baselineIds: actionable.map((record) => record.id),
      assignments: { [actionable[0].id]: 'u1-prose-none' },
    };
    assert.equal(
      materializeClassifications({ cssScan, producerRecords, config: baselineConfig }).length,
      cssScan.records.length + producerRecords.length,
    );
    baselineConfig.baselineIds.push(actionable[0].id);
    assert.throws(
      () => materializeClassifications({ cssScan, producerRecords, config: baselineConfig }),
      /duplicate baseline assignment/i,
    );
  });
});
