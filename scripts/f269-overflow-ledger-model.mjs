const ENUMS = Object.freeze({
  contentKind: new Set(['identifier', 'prose', 'long-form', 'critical', 'diagnostic', 'non-content']),
  truncationStage: new Set([
    'css-clamp',
    'web-physical-slice',
    'api-preview',
    'canonical-source-cap',
    'not-applicable',
  ]),
  fullContentAvailability: new Set([
    'current-dom',
    'current-payload',
    'drill-source',
    'permanently-lost',
    'not-applicable',
  ]),
  currentRecovery: new Set(['none', 'tooltip', 'inline-expand', 'detail-reader', 'source-jump', 'copy']),
  severity: new Set(['U0', 'U1', 'U2', 'U3', 'U4']),
  targetPattern: new Set([
    'compact-label',
    'expandable-prose',
    'long-form-reader',
    'critical-text',
    'retain',
    'exclude',
  ]),
});

function requireNonEmptyString(record, field) {
  if (typeof record[field] !== 'string' || record[field].trim() === '') {
    throw new Error(`classification ${record.id} requires non-empty ${field}`);
  }
}

function requireEnum(record, field) {
  if (!ENUMS[field].has(record[field])) {
    throw new Error(`classification ${record.id} has invalid ${field}: ${record[field]}`);
  }
}

function validateRecoveryContract(record) {
  if (
    !Array.isArray(record.currentRecovery) ||
    record.currentRecovery.some((item) => !ENUMS.currentRecovery.has(item))
  ) {
    throw new Error(`classification ${record.id} has invalid currentRecovery`);
  }
  const coverage = record.inputCoverage;
  if (
    !coverage ||
    ['mouse', 'keyboard', 'touch', 'screenReader'].some((field) => typeof coverage[field] !== 'boolean')
  ) {
    throw new Error(`classification ${record.id} has invalid inputCoverage`);
  }
}

function validateClassifiedRecord(record) {
  requireEnum(record, 'severity');
  if (record.targetPattern === 'exclude') {
    throw new Error(`classified record ${record.id} cannot target exclude`);
  }
}

function validateExcludedRecord(record) {
  requireNonEmptyString(record, 'exclusionReason');
  if (record.severity !== undefined) throw new Error(`excluded record ${record.id} cannot declare severity`);
  const usesExcludedContract =
    record.contentKind === 'non-content' &&
    record.truncationStage === 'not-applicable' &&
    record.fullContentAvailability === 'not-applicable' &&
    record.targetPattern === 'exclude';
  if (!usesExcludedContract) {
    throw new Error(`excluded record ${record.id} must use not-applicable/exclude fields`);
  }
}

function validateDisposition(record) {
  if (record.disposition === 'classified') return validateClassifiedRecord(record);
  if (record.disposition === 'excluded') return validateExcludedRecord(record);
  throw new Error(`classification ${record.id} has invalid disposition: ${record.disposition}`);
}

function validateClassification(record) {
  for (const field of ['surface', 'component', 'field', 'owner', 'rationale']) requireNonEmptyString(record, field);
  for (const field of ['contentKind', 'truncationStage', 'fullContentAvailability', 'targetPattern']) {
    requireEnum(record, field);
  }
  validateRecoveryContract(record);
  validateDisposition(record);
}

function validateMetadata(metadata) {
  if (!metadata || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata.auditBaseSha ?? '')) {
    throw new Error('metadata.auditBaseSha must be a lowercase Git object id');
  }
  if (!/^[0-9a-f]{64}$/.test(metadata.auditSourceFingerprint ?? '')) {
    throw new Error('metadata.auditSourceFingerprint must be a lowercase SHA-256 digest');
  }
  for (const field of ['auditFreshnessRef', 'scannerVersion', 'scannerCommand', 'generatedAt']) {
    if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
      throw new Error(`metadata.${field} is required`);
    }
  }
  if (
    metadata.screenshotNote !== undefined &&
    (typeof metadata.screenshotNote !== 'string' || metadata.screenshotNote.trim() === '')
  ) {
    throw new Error('metadata.screenshotNote must be non-empty when provided');
  }
}

function indexClassifications(classifications) {
  const classificationById = new Map();
  for (const classification of classifications) {
    if (classificationById.has(classification.id)) {
      throw new Error(`duplicate classification: ${classification.id}`);
    }
    classificationById.set(classification.id, classification);
  }
  return classificationById;
}

function assertExactClassificationJoin(sources, classifications, classificationById) {
  const sourceById = new Map(sources.map((record) => [record.id, record]));
  if (sourceById.size !== sources.length) throw new Error('duplicate source record id');
  const missing = sources.filter((source) => !classificationById.has(source.id)).map((source) => source.id);
  if (missing.length > 0) throw new Error(`missing classification: ${missing.join(', ')}`);
  const stale = classifications.filter((classification) => !sourceById.has(classification.id)).map((item) => item.id);
  if (stale.length > 0) throw new Error(`stale classification: ${stale.join(', ')}`);
}

function assertSourceStage(source, classification) {
  if (classification.disposition !== 'classified') return;
  if (source.sourceKind === 'physical-producer' && classification.truncationStage === 'css-clamp') {
    throw new Error(`physical producer ${source.id} cannot use css-clamp`);
  }
  if (source.sourceKind === 'css-lexical' && classification.truncationStage !== 'css-clamp') {
    throw new Error(`CSS source ${source.id} must use css-clamp`);
  }
}

function mergeRecord(source, classification) {
  validateClassification(classification);
  assertSourceStage(source, classification);
  return { ...source, ...classification, id: source.id };
}

function summarizeRecords(cssScan, producerRecords, records) {
  const bySeverity = { U0: 0, U1: 0, U2: 0, U3: 0, U4: 0 };
  const counts = {
    classifiedCssMatches: 0,
    explicitlyExcludedLexicalMatches: 0,
    classifiedTextTokenMatches: 0,
    explicitlyExcludedTextTokenMatches: 0,
    classifiedRecords: 0,
    excludedRecords: 0,
  };

  for (const record of records) {
    if (record.disposition === 'classified') {
      counts.classifiedRecords += 1;
      bySeverity[record.severity] += 1;
      if (record.sourceKind === 'css-lexical') {
        counts.classifiedCssMatches += record.lexicalMatchCount;
        counts.classifiedTextTokenMatches += record.textTokenMatchCount;
      }
    } else {
      counts.excludedRecords += 1;
      if (record.sourceKind === 'css-lexical') {
        counts.explicitlyExcludedLexicalMatches += record.lexicalMatchCount;
        counts.explicitlyExcludedTextTokenMatches += record.textTokenMatchCount;
      }
    }
  }

  return {
    rawLexicalFiles: cssScan.rawLexicalFiles,
    rawLexicalMatches: cssScan.rawLexicalMatches,
    textTokenFiles: cssScan.textTokenFiles,
    textTokenMatches: cssScan.textTokenMatches,
    ...counts,
    physicalProducerRecords: producerRecords.length,
    inventoryRecords: records.length,
    bySeverity,
  };
}

function assertCoverageEquations(coverage, records) {
  const summedLexical = records
    .filter((record) => record.sourceKind === 'css-lexical')
    .reduce((sum, record) => sum + record.lexicalMatchCount, 0);
  if (
    coverage.rawLexicalMatches !== summedLexical ||
    coverage.rawLexicalMatches !== coverage.classifiedCssMatches + coverage.explicitlyExcludedLexicalMatches
  ) {
    throw new Error('raw lexical coverage equation failed');
  }
  if (
    coverage.textTokenMatches !== coverage.classifiedTextTokenMatches + coverage.explicitlyExcludedTextTokenMatches ||
    coverage.textTokenMatches > coverage.rawLexicalMatches
  ) {
    throw new Error('text token coverage equation failed');
  }
  if (coverage.inventoryRecords !== coverage.classifiedRecords + coverage.excludedRecords) {
    throw new Error('inventory record coverage equation failed');
  }
  if (coverage.classifiedRecords !== Object.values(coverage.bySeverity).reduce((sum, count) => sum + count, 0)) {
    throw new Error('severity coverage equation failed');
  }
}

export function buildLedger({ metadata, cssScan, producerRecords, classifications }) {
  validateMetadata(metadata);
  const sources = [...cssScan.records, ...producerRecords];
  const classificationById = indexClassifications(classifications);
  assertExactClassificationJoin(sources, classifications, classificationById);
  const records = sources.map((source) => mergeRecord(source, classificationById.get(source.id)));
  const coverage = summarizeRecords(cssScan, producerRecords, records);
  assertCoverageEquations(coverage, records);

  return { schemaVersion: 1, metadata: { ...metadata }, coverage, records };
}
