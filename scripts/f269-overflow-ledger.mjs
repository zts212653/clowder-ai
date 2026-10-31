#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeClassifications } from './f269-overflow-ledger-classify.mjs';
import { KNOWN_PRODUCER_LOCATORS } from './f269-overflow-ledger-locators.mjs';
import { buildLedger } from './f269-overflow-ledger-model.mjs';
import {
  assertArtifactContentsCurrent,
  buildArtifactContents,
  writeArtifactContents,
} from './f269-overflow-ledger-report.mjs';
import {
  assertAuditSourceMatchesBase,
  computeAuditSourceFingerprint,
  scanCssLexical,
  scanPhysicalProducers,
} from './f269-overflow-ledger-scan.mjs';

export { materializeClassifications } from './f269-overflow-ledger-classify.mjs';
export { KNOWN_PRODUCER_LOCATORS } from './f269-overflow-ledger-locators.mjs';
export { buildLedger } from './f269-overflow-ledger-model.mjs';
export {
  assertArtifactContentsCurrent,
  buildArtifactContents,
  renderMarkdownReport,
  writeArtifactContents,
} from './f269-overflow-ledger-report.mjs';
export {
  assertAuditSourceMatchesBase,
  computeAuditSourceFingerprint,
  scanCssLexical,
  scanPhysicalProducers,
} from './f269-overflow-ledger-scan.mjs';

export const SCANNER_VERSION = 'f269-phase-c-v6';

const AUDIT_SOURCE_PATHS = ['packages/web/src', 'packages/api/src/routes/callback-anchor-helpers.ts'];

export function buildRepoLedger({ rootDir, config, auditSourceFingerprint }) {
  const auditBaseSha = config?.metadata?.auditBaseSha;
  assertAuditSourceMatchesBase({
    rootDir,
    auditBaseSha,
    auditSourceFingerprint,
    sourcePaths: AUDIT_SOURCE_PATHS,
    freshnessRef: config?.metadata?.auditFreshnessRef,
  });
  const resolvedSourceFingerprint =
    auditSourceFingerprint ??
    computeAuditSourceFingerprint({
      rootDir,
      ref: auditBaseSha,
      sourcePaths: AUDIT_SOURCE_PATHS,
    });
  const cssScan = scanCssLexical({ rootDir });
  const producerRecords = scanPhysicalProducers({ rootDir, locators: KNOWN_PRODUCER_LOCATORS });
  const classifications = materializeClassifications({ cssScan, producerRecords, config });
  return buildLedger({
    metadata: {
      ...config.metadata,
      auditSourceFingerprint: resolvedSourceFingerprint,
      scannerVersion: SCANNER_VERSION,
      scannerCommand: 'pnpm audit:f269-overflow -- --check',
    },
    cssScan,
    producerRecords,
    classifications,
  });
}

function artifactPaths(rootDir) {
  const directory = join(rootDir, 'docs/features/assets/F269');
  return {
    json: join(directory, 'overflow-ledger.json'),
    markdown: join(directory, 'overflow-ledger.md'),
  };
}

function printInventory(rootDir) {
  const cssScan = scanCssLexical({ rootDir });
  const producerRecords = scanPhysicalProducers({ rootDir, locators: KNOWN_PRODUCER_LOCATORS });
  const actionable = [...cssScan.records, ...producerRecords].filter(
    (record) => record.candidateKind !== 'lexical-noise',
  );
  for (const record of actionable) process.stdout.write(`${record.id}\t${record.sourceExcerpt}\n`);
}

export function runCli({ rootDir = process.cwd(), args = process.argv.slice(2) } = {}) {
  const mode = args.includes('--write') ? 'write' : args.includes('--inventory') ? 'inventory' : 'check';
  if (mode === 'inventory') {
    printInventory(rootDir);
    return;
  }
  const configPath = join(rootDir, 'docs/features/assets/F269/overflow-classifications.json');
  if (!existsSync(configPath)) throw new Error(`classification config not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const paths = artifactPaths(rootDir);
  const existingLedger =
    mode === 'check' && existsSync(paths.json) ? JSON.parse(readFileSync(paths.json, 'utf8')) : undefined;
  const ledger = buildRepoLedger({
    rootDir,
    config,
    auditSourceFingerprint: existingLedger?.metadata?.auditSourceFingerprint,
  });
  const artifacts = buildArtifactContents(ledger);
  if (mode === 'write') {
    writeArtifactContents({ artifacts, paths });
    process.stdout.write(
      `wrote ${relative(rootDir, paths.json)} and ${relative(rootDir, paths.markdown)} (${ledger.coverage.classifiedRecords} classified, ${ledger.coverage.excludedRecords} excluded)\n`,
    );
    return;
  }
  assertArtifactContentsCurrent({ artifacts, paths });
  process.stdout.write(
    `F269 overflow ledger current: ${ledger.coverage.inventoryRecords} records, ${ledger.coverage.rawLexicalMatches} raw lexical matches\n`,
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
