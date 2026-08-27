import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  AcceptedEvidence,
  FindingEvidence,
  TrajectoryInspectorBaselineCohort,
  TrajectoryInspectorExternalEvidenceSource,
} from './trajectory-inspector-source-provider.js';
import {
  type TrajectoryInspectorWindowSelector,
  trajectoryInspectorCanonicalEvidenceRefSchema,
} from './trajectory-inspector-types.js';

const execFileAsync = promisify(execFile);

const findingSchema = z
  .object({
    kind: z.literal('f192-invocation-finding'),
    invocationId: z.string().min(1),
    foundAtMs: z.number().int().nonnegative(),
    threadId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    sourceRefs: z.array(trajectoryInspectorCanonicalEvidenceRefSchema).min(1),
  })
  .strict();

const acceptedSchema = z
  .object({
    kind: z.literal('f299-accepted-evidence'),
    invocationId: z.string().min(1),
    acceptedAtMs: z.number().int().nonnegative(),
    reviewerAgreement: z.enum(['agreed', 'disagreed']),
    sourceRefs: z.array(trajectoryInspectorCanonicalEvidenceRefSchema).min(1),
  })
  .strict();

const evidenceSchema = z.discriminatedUnion('kind', [findingSchema, acceptedSchema]);
type EvidenceRecord = z.infer<typeof evidenceSchema>;

const baselineSnapshotSchema = z
  .object({
    featureId: z.literal('F299'),
    window: z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).passthrough(),
    validity: z
      .object({
        status: z.enum(['usable', 'calibration_only', 'invalid']),
        canonicalCoverage: z.number().min(0).max(1),
        reviewerDisagreementRate: z.number().min(0).max(1).nullable(),
      })
      .passthrough(),
    sourceHealth: z.object({ modelRuntimeFingerprints: z.array(z.string().min(1)) }).passthrough(),
    trajectoryInspectorVector: z
      .object({ eligibleEpisodes: z.number().int().nonnegative(), wrongRef: z.number().int().nonnegative() })
      .passthrough(),
    trajectoryInspectorCohort: z
      .object({ anomalyKinds: z.array(z.enum(['error', 'cancelled', 'timeout', 'finding'])) })
      .strict(),
  })
  .passthrough();

export interface TrajectoryInspectorArtifactTruth {
  listCommitted(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

export class GitTrajectoryInspectorArtifactTruth implements TrajectoryInspectorArtifactTruth {
  constructor(private readonly repoRoot: string) {}

  async listCommitted(paths: readonly string[]): Promise<ReadonlySet<string>> {
    const byRepoRelative = new Map<string, string>();
    for (const path of paths) {
      const repoRelative = relative(this.repoRoot, path);
      if (!repoRelative || isAbsolute(repoRelative) || repoRelative === '..' || repoRelative.startsWith(`..${sep}`)) {
        continue;
      }
      byRepoRelative.set(repoRelative, path);
    }
    const candidates = [...byRepoRelative.keys()];
    if (candidates.length === 0) return new Set();
    const [{ stdout: trackedOutput }, { stdout: dirtyOutput }] = await Promise.all([
      execFileAsync('git', ['-C', this.repoRoot, 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...candidates]),
      execFileAsync('git', ['-C', this.repoRoot, 'diff', '-z', '--name-only', 'HEAD', '--', ...candidates]),
    ]);
    const dirty = new Set(splitNul(dirtyOutput));
    return new Set(
      splitNul(trackedOutput)
        .filter((repoRelative) => !dirty.has(repoRelative))
        .map((repoRelative) => byRepoRelative.get(repoRelative))
        .filter((path): path is string => path !== undefined),
    );
  }
}

export class RepoTrajectoryInspectorEvidenceSource implements TrajectoryInspectorExternalEvidenceSource {
  constructor(
    private readonly deps: {
      harnessFeedbackRoot: string;
      artifactTruth: TrajectoryInspectorArtifactTruth;
    },
  ) {}

  async listFindings(selector: TrajectoryInspectorWindowSelector): Promise<FindingEvidence[]> {
    return (await this.readEvidence())
      .filter(
        (record): record is z.infer<typeof findingSchema> =>
          record.kind === 'f192-invocation-finding' && insideWindow(record.foundAtMs, selector),
      )
      .map(({ kind: _kind, ...record }) => record);
  }

  async listAcceptedEvidence(selector: TrajectoryInspectorWindowSelector): Promise<AcceptedEvidence[]> {
    return (await this.readEvidence())
      .filter(
        (record): record is z.infer<typeof acceptedSchema> =>
          record.kind === 'f299-accepted-evidence' && insideWindow(record.acceptedAtMs, selector),
      )
      .map(({ kind: _kind, ...record }) => record);
  }

  async hasComparableBaseline(
    selector: TrajectoryInspectorWindowSelector,
    cohort: TrajectoryInspectorBaselineCohort,
  ): Promise<boolean> {
    const snapshots = await this.readBaselineSnapshots();
    return snapshots.some(
      (snapshot) =>
        snapshot.window.endMs <= selector.windowStartMs &&
        snapshot.validity.status !== 'invalid' &&
        snapshot.validity.canonicalCoverage === 1 &&
        (snapshot.validity.reviewerDisagreementRate === null || snapshot.validity.reviewerDisagreementRate <= 0.2) &&
        snapshot.trajectoryInspectorVector.eligibleEpisodes > 0 &&
        snapshot.trajectoryInspectorVector.wrongRef === 0 &&
        sameStrings(snapshot.sourceHealth.modelRuntimeFingerprints, cohort.modelRuntimeFingerprints) &&
        sameStrings(snapshot.trajectoryInspectorCohort.anomalyKinds, cohort.anomalyKinds),
    );
  }

  private async readEvidence(): Promise<EvidenceRecord[]> {
    const bundlesRoot = join(this.deps.harnessFeedbackRoot, 'bundles');
    let bundleNames: string[];
    try {
      bundleNames = (await readdir(bundlesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const paths = bundleNames.flatMap((bundleName) =>
      ['snapshot.json', 'attribution.json'].map((filename) => join(bundlesRoot, bundleName, filename)),
    );
    const committed = await this.deps.artifactTruth.listCommitted(paths);
    const rows = (
      await Promise.all(paths.filter((path) => committed.has(path)).map((path) => this.readArtifact(path)))
    ).flat();
    const unique = new Map<string, EvidenceRecord>();
    for (const row of rows) {
      const timestamp = row.kind === 'f192-invocation-finding' ? row.foundAtMs : row.acceptedAtMs;
      const key = `${row.kind}:${row.invocationId}:${timestamp}`;
      const existing = unique.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
        throw new Error(`conflicting trajectory inspector evidence: ${key}`);
      }
      unique.set(key, row);
    }
    return [...unique.values()].sort(compareEvidence);
  }

  private async readArtifact(path: string): Promise<EvidenceRecord[]> {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const artifact = JSON.parse(content) as { trajectoryInspectorEvidence?: unknown };
    if (artifact.trajectoryInspectorEvidence === undefined) return [];
    return z.array(evidenceSchema).parse(artifact.trajectoryInspectorEvidence);
  }

  private async readBaselineSnapshots(): Promise<z.infer<typeof baselineSnapshotSchema>[]> {
    const bundlesRoot = join(this.deps.harnessFeedbackRoot, 'bundles');
    let bundleNames: string[];
    try {
      bundleNames = (await readdir(bundlesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const paths = bundleNames.map((bundleName) => join(bundlesRoot, bundleName, 'snapshot.json'));
    const committed = await this.deps.artifactTruth.listCommitted(paths);
    const snapshots = await Promise.all(
      paths.map(async (path) => {
        if (!committed.has(path)) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        if (!isRecord(parsed) || parsed.featureId !== 'F299' || !('trajectoryInspectorCohort' in parsed)) return null;
        return baselineSnapshotSchema.parse(parsed);
      }),
    );
    return snapshots.filter((snapshot): snapshot is z.infer<typeof baselineSnapshotSchema> => snapshot !== null);
  }
}

function compareEvidence(left: EvidenceRecord, right: EvidenceRecord): number {
  const leftAt = left.kind === 'f192-invocation-finding' ? left.foundAtMs : left.acceptedAtMs;
  const rightAt = right.kind === 'f192-invocation-finding' ? right.foundAtMs : right.acceptedAtMs;
  return leftAt - rightAt || left.invocationId.localeCompare(right.invocationId) || left.kind.localeCompare(right.kind);
}

function insideWindow(value: number, selector: TrajectoryInspectorWindowSelector): boolean {
  return value >= selector.windowStartMs && value < selector.windowEndMs;
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function splitNul(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
