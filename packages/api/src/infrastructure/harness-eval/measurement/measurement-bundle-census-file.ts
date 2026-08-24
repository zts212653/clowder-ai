import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parseDocument, stringify as stringifyYaml } from 'yaml';

import {
  loadMeasurementBundleRegistry,
  MeasurementBundleCensusSchema,
  refreshMeasurementBundleCensus,
} from './measurement-bundle-census.js';
import {
  createPublicMeasurementBundleCensus,
  reconcilePublicMeasurementBundleCensus,
} from './measurement-bundle-census-bootstrap.js';

export const MEASUREMENT_BUNDLE_CENSUS_REF = 'docs/harness-feedback/registry/measurement-bundles.yaml';
const DERIVED_ROOT_FIELDS = new Set(['generatedAt', 'verdictCorpusHash', 'committedVerdictArtifactCount', 'entries']);

function parseCensusDocument(source: string) {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`measurement bundle census YAML is invalid: ${document.errors[0]?.message ?? 'unknown error'}`);
  }
  return document;
}

function nonDerivedMetadata(input: unknown) {
  const census = MeasurementBundleCensusSchema.parse(input);
  return {
    ...Object.fromEntries(Object.entries(census).filter(([field]) => !DERIVED_ROOT_FIELDS.has(field))),
    entries: census.entries.map((entry) =>
      Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'committedVerdictArtifactCount')),
    ),
  };
}

export function readMeasurementBundleCensusFile(repoRoot: string): string {
  return readFileSync(resolve(repoRoot, MEASUREMENT_BUNDLE_CENSUS_REF), 'utf8');
}

function writeMeasurementBundleCensusFileAtomically(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, source, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may not exist or may already have been renamed.
    }
    throw error;
  }
}

export function ensureMeasurementBundleCensusFile(
  repoRoot: string,
  generatedAt: string,
): { path: string; source: string; created: boolean; reconciled: boolean } {
  const path = resolve(repoRoot, MEASUREMENT_BUNDLE_CENSUS_REF);
  if (!existsSync(path)) {
    const source = stringifyYaml(createPublicMeasurementBundleCensus(repoRoot, generatedAt));
    writeMeasurementBundleCensusFileAtomically(path, source);
    return { path, source, created: true, reconciled: false };
  }

  const currentSource = readMeasurementBundleCensusFile(repoRoot);
  const current = MeasurementBundleCensusSchema.parse(parseCensusDocument(currentSource).toJS());
  const currentIds = new Set(current.entries.map((entry) => entry.domainId));
  const registryIds = loadMeasurementBundleRegistry(repoRoot).map((domain) => domain.domainId);
  const needsReconciliation = registryIds.some((domainId) => !currentIds.has(domainId));
  if (!needsReconciliation) {
    refreshMeasurementBundleCensus(current, repoRoot, generatedAt);
    return { path, source: currentSource, created: false, reconciled: false };
  }

  const source = stringifyYaml(reconcilePublicMeasurementBundleCensus(current, repoRoot, generatedAt));
  writeMeasurementBundleCensusFileAtomically(path, source);
  return { path, source, created: false, reconciled: true };
}

export function refreshMeasurementBundleCensusFile(repoRoot: string, generatedAt: string, cleanSource: string): string {
  const path = resolve(repoRoot, MEASUREMENT_BUNDLE_CENSUS_REF);
  const currentDocument = parseCensusDocument(readMeasurementBundleCensusFile(repoRoot));
  const cleanDocument = parseCensusDocument(cleanSource);
  if (!isDeepStrictEqual(nonDerivedMetadata(currentDocument.toJS()), nonDerivedMetadata(cleanDocument.toJS()))) {
    throw new Error('measurement bundle census non-derived metadata changed during verdict generation');
  }

  const refreshed = refreshMeasurementBundleCensus(cleanDocument.toJS(), repoRoot, generatedAt);
  cleanDocument.set('generatedAt', refreshed.generatedAt);
  cleanDocument.set('verdictCorpusHash', refreshed.verdictCorpusHash);
  cleanDocument.set('committedVerdictArtifactCount', refreshed.committedVerdictArtifactCount);
  for (const [index, entry] of refreshed.entries.entries()) {
    cleanDocument.setIn(['entries', index, 'committedVerdictArtifactCount'], entry.committedVerdictArtifactCount);
  }
  writeMeasurementBundleCensusFileAtomically(path, cleanDocument.toString());
  return path;
}
