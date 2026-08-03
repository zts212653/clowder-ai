import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parseDocument } from 'yaml';

import { MeasurementBundleCensusSchema, refreshMeasurementBundleCensus } from './measurement-bundle-census.js';

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
  writeFileSync(path, cleanDocument.toString());
  return path;
}
