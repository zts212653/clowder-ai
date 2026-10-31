import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { ZodError } from 'zod';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import {
  type ArchiveFileRef,
  type ArchiveRecord,
  archiveManifestSchema,
  archivePathSchema,
  type FootballArchiveManifest,
  type FootballIndex,
  footballCatalogSchema,
  footballComparisonSchema,
  footballIndexSchema,
} from './archive-schema.js';

// Optional data owned by this installation, not a bundled public fixture. Missing archive data leaves owner versions readable.
export const FOOTBALL_ARCHIVE_ROOT = 'docs/videos/f311-microduck-roadshow/pipeline/football';
const CATALOG = 'readiness/20260909-demo/catalog.json';
const COMPARISON = 'readiness/20260909-short-approach/comparison.json';
export const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export class ArchiveIntegrityError extends Error {}
export function archiveFailureStatus(error: unknown): 'invalid' | 'unavailable' {
  return error instanceof ArchiveIntegrityError || error instanceof ZodError || error instanceof SyntaxError
    ? 'invalid'
    : 'unavailable';
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  return value;
}
export const archiveDigest = (value: unknown): string => digestBytes(Buffer.from(`${JSON.stringify(sorted(value))}\n`));
export const archiveRef = (kind: string, digest: string): OwnerTruthRefV1 => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `${kind}:sha256:${digest}`,
  version: digest,
});

/** Fingerprint is only a grouping key for public archives, never a deployable owner asset version. */
export function controllerFingerprint(index: FootballIndex): string {
  const { plan } = index;
  const algorithm = plan.approachAlgorithm ?? (plan.approachController ? 'body_xy' : 'direct');
  const names = ['football_contract.py'];
  if (algorithm !== 'direct') names.push('approach_controller.py');
  if (['forward_arc_csc', 'reverse_arc_then_forward_csc'].includes(algorithm))
    names.push('arc_controller.py', 'arc_path.py');
  if (algorithm === 'reverse_arc_then_forward_csc') names.push('short_controller.py', 'short_path.py');
  if (names.some((name) => !index.codeFiles[`football/${name}`]))
    throw new ArchiveIntegrityError('controller code provenance missing');
  return archiveDigest({
    algorithm,
    config: plan.approachController ?? null,
    actionScale: plan.actionScale,
    modelFiles: plan.modelFiles,
    observationLayout: plan.observationLayout,
    controllerCode: Object.fromEntries(names.map((name) => [name, index.codeFiles[`football/${name}`]])),
  });
}

export interface ArchiveReader {
  read(path: string): Promise<Uint8Array>;
  verified(ref: ArchiveFileRef): Promise<Uint8Array>;
}
export function createArchiveReader(options: MicroduckLocalEvidenceOptions): ArchiveReader {
  const root = resolve(options.repoRoot, FOOTBALL_ARCHIVE_ROOT);
  const rawRead = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const read = async (path: string) => {
    if (path !== CATALOG && path !== COMPARISON) archivePathSchema.parse(path);
    const bytes = await rawRead(resolve(root, path));
    if (!bytes.byteLength || bytes.byteLength > 40_000_000)
      throw new ArchiveIntegrityError('archive size outside read boundary');
    return bytes;
  };
  return {
    read,
    async verified(ref) {
      archivePathSchema.parse(ref.path);
      const bytes = await read(ref.path);
      if (digestBytes(bytes) !== ref.sha256) throw new ArchiveIntegrityError('archive hash mismatch');
      return bytes;
    },
  };
}
const json = (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString('utf8'));

export interface FootballArchiveRun {
  id: string;
  version: string;
  fingerprint: string;
  nodeRef: OwnerTruthRefV1;
  experimentRef: OwnerTruthRefV1;
  index: FootballIndex;
  indexRef: ArchiveFileRef;
  manifest: FootballArchiveManifest;
  manifestRef: ArchiveFileRef;
  records: ArchiveRecord[];
}
export interface FootballArchiveCatalog {
  sourceRef: OwnerTruthRefV1;
  versions: Array<{
    id: string;
    parent: string | null;
    summary: string;
    fingerprint: string;
    sourceRef: OwnerTruthRefV1;
  }>;
  runs: FootballArchiveRun[];
}

async function readRun(
  reader: ArchiveReader,
  input: {
    id: string;
    version: string;
    fingerprint: string;
    indexRef: ArchiveFileRef;
    manifestRef?: ArchiveFileRef;
    records: ArchiveRecord[];
  },
): Promise<FootballArchiveRun> {
  const index = footballIndexSchema.parse(json(await reader.verified(input.indexRef)));
  const manifestPath = `evidence/${input.id}/archive-manifest.json`;
  const manifestBytes = input.manifestRef ? await reader.verified(input.manifestRef) : await reader.read(manifestPath);
  const manifest = archiveManifestSchema.parse(json(manifestBytes));
  if (
    manifest.files['index.json']?.sha256 !== input.indexRef.sha256 ||
    controllerFingerprint(index) !== input.fingerprint
  )
    throw new ArchiveIntegrityError('run index or grouping provenance drift');
  if (
    index.plan.cases.length !== index.episodes.length ||
    new Set(index.episodes.map((episode) => episode.case.id)).size !== index.episodes.length ||
    input.records.length !== index.episodes.length
  )
    throw new ArchiveIntegrityError('archive record inventory mismatch');
  for (const episode of index.episodes) {
    const record = input.records.find((row) => row.caseId === episode.case.id);
    const planned = index.plan.cases.find((entry) => entry.id === episode.case.id);
    if (
      !record ||
      archiveDigest(planned) !== archiveDigest(episode.case) ||
      record.captureRef.path !== `evidence/${input.id}/${episode.capture}` ||
      record.captureRef.sha256 !== episode.compressedSha256 ||
      record.uncompressedSha256 !== episode.uncompressedSha256 ||
      manifest.files[episode.capture]?.sha256 !== episode.compressedSha256
    )
      throw new ArchiveIntegrityError('capture escaped its run');
  }
  return {
    ...input,
    index,
    manifest,
    nodeRef: archiveRef('public-controller', input.fingerprint),
    experimentRef: archiveRef(`public-run-${input.id}`, input.indexRef.sha256),
    manifestRef: { path: manifestPath, sha256: digestBytes(manifestBytes) },
  };
}

/** Inventory locates sources; the owner re-reads each exact run and checks its original manifest. */
export async function readFootballArchiveCatalog(reader: ArchiveReader): Promise<FootballArchiveCatalog> {
  const [catalogBytes, comparisonBytes] = await Promise.all([reader.read(CATALOG), reader.read(COMPARISON)]);
  const catalog = footballCatalogSchema.parse(json(catalogBytes));
  const comparison = footballComparisonSchema.parse(json(comparisonBytes));
  const versions = catalog.versions.map((version) => ({
    id: version.id,
    parent: version.parent,
    summary: version.change,
    fingerprint: version.controllerFingerprintSha256,
    sourceRef: archiveRef('archive-catalog', digestBytes(catalogBytes)),
  }));
  const runs: FootballArchiveRun[] = [];
  for (const entry of catalog.runs) {
    const version = versions.find((version) => version.id === entry.versionId);
    if (!version) throw new ArchiveIntegrityError('archive has no version group');
    runs.push(
      await readRun(reader, {
        id: entry.id,
        version: entry.versionId,
        fingerprint: version.fingerprint,
        indexRef: entry.indexRef,
        manifestRef: entry.archiveManifestRef,
        records: catalog.episodes.filter((record) => record.runId === entry.id),
      }),
    );
  }
  for (const entry of comparison.runs) {
    const id = entry.indexRef.path.split('/')[1] as string;
    const existing = runs.find((run) => run.id === id);
    if (existing) {
      if (
        existing.indexRef.sha256 !== entry.indexRef.sha256 ||
        existing.fingerprint !== entry.controllerFingerprintSha256
      )
        throw new ArchiveIntegrityError('shared comparison run disagrees with the archive');
      continue;
    }
    const run = await readRun(reader, {
      id,
      version: entry.version,
      fingerprint: entry.controllerFingerprintSha256,
      indexRef: entry.indexRef,
      records: comparison.episodes
        .filter((record) => record.version === entry.version)
        .map((record) => ({ ...record, runId: id, versionId: entry.version })),
    });
    runs.push(run);
    versions.push({
      id: entry.version,
      // The comparison inventory declares membership, not ancestry. Array order is never a parent proof.
      parent: null,
      fingerprint: run.fingerprint,
      summary: run.index.plan.changeFromPrevious?.reason ?? '已归档的公开控制器改动；未形成正式采用。',
      sourceRef: archiveRef('run-index', run.indexRef.sha256),
    });
  }
  return {
    sourceRef: archiveRef(
      'public-archive-publication',
      archiveDigest([digestBytes(catalogBytes), digestBytes(comparisonBytes)]),
    ),
    versions,
    runs,
  };
}
