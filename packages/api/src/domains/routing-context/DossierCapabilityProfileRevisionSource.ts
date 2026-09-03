import { createHash } from 'node:crypto';
import { capabilityProfileRevisionRefV1Schema, catRegistry } from '@cat-cafe/shared';
import { type DossierProfile, isDossierAvailable, loadDossierProfiles } from '@cat-cafe/shared/dossier';
import type {
  CapabilityPendingProposalReader,
  CapabilityProfileRevisionLoadInput,
  CapabilityProfileRevisionLoadResult,
  CapabilityProfileRevisionSource,
} from './CapabilityProfileRevisionSource.js';

interface DossierCapabilityProfileRevisionSourceOptions {
  projectRoot: string;
  dossierMode?: 'required' | 'optional';
  modelResolver?: (catId: string) => string | undefined;
  pendingProposalReader?: CapabilityPendingProposalReader;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function profileRevision(profile: DossierProfile): string {
  return `sha256:${createHash('sha256').update(canonicalJson(profile)).digest('hex')}`;
}

function profileTimestamp(profile: DossierProfile): number {
  const timestamp = Date.parse(profile.provenance?.date ?? '');
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function evidenceRefs(profile: DossierProfile, catId: string): string[] {
  const sources = profile.provenance?.primarySources?.filter((source) => source.trim().length > 0);
  return [...new Set(sources?.length ? sources : [`docs/team/cat-dossier.md#cat:${catId}`])].slice(0, 16);
}

function affectedCandidates(input: CapabilityProfileRevisionLoadInput): string[] {
  return [...new Set(input.candidates.map((candidate) => candidate.catId))].sort();
}

export class DossierCapabilityProfileRevisionSource implements CapabilityProfileRevisionSource {
  private readonly projectRoot: string;
  private readonly dossierMode: 'required' | 'optional';
  private readonly modelResolver: (catId: string) => string | undefined;
  private readonly pendingProposalReader: CapabilityPendingProposalReader;

  constructor(options: DossierCapabilityProfileRevisionSourceOptions) {
    this.projectRoot = options.projectRoot;
    this.dossierMode = options.dossierMode ?? 'required';
    this.modelResolver = options.modelResolver ?? ((catId) => catRegistry.tryGet(catId)?.config.defaultModel);
    this.pendingProposalReader = options.pendingProposalReader ?? { countPending: async () => 0 };
  }

  async load(input: CapabilityProfileRevisionLoadInput): Promise<CapabilityProfileRevisionLoadResult> {
    const profilesByCat = loadDossierProfiles(this.projectRoot);
    const dossierAvailable = isDossierAvailable(this.projectRoot);
    const candidateIds = affectedCandidates(input);

    if (!dossierAvailable) {
      if (this.dossierMode === 'required') {
        return { status: 'degraded', reason: 'dossier_unavailable', affectedCatIds: candidateIds };
      }
      return { status: 'fresh', profiles: [], absentCatIds: candidateIds };
    }

    if (profilesByCat.size === 0 && this.dossierMode === 'required' && candidateIds.length > 0) {
      return {
        status: 'degraded',
        reason: 'dossier_unreadable_or_empty',
        affectedCatIds: candidateIds,
      };
    }

    const absentCatIds = candidateIds.filter((catId) => !profilesByCat.has(catId));
    const missingModels = candidateIds.filter(
      (catId) => profilesByCat.has(catId) && this.modelResolver(catId) === undefined,
    );
    if (missingModels.length > 0) {
      return { status: 'degraded', reason: 'model_missing', affectedCatIds: missingModels };
    }

    const appliedProfiles = await Promise.all(
      candidateIds.flatMap((catId) => {
        const profile = profilesByCat.get(catId);
        const modelId = this.modelResolver(catId);
        if (profile === undefined || modelId === undefined) return [];
        const sources = evidenceRefs(profile, catId);
        const relevantSignals = [
          ...(profile.routingSignals?.peakCapabilities ?? []).map((summary) => ({
            kind: 'strength' as const,
            summary,
            evidenceRefs: sources,
          })),
          ...(profile.routingSignals?.antiSignals ?? []).map((summary) => ({
            kind: 'anti_signal' as const,
            summary,
            evidenceRefs: sources,
          })),
        ].slice(0, 16);
        return [
          this.pendingProposalReader.countPending({ ownerId: input.ownerId, catId }).then((pendingProposalCount) =>
            capabilityProfileRevisionRefV1Schema.parse({
              v: 1,
              catId,
              modelId,
              dossierRevision: profileRevision(profile),
              updatedAt: profileTimestamp(profile),
              relevantSignals,
              pendingProposalCount,
            }),
          ),
        ];
      }),
    );

    return { status: 'fresh', profiles: appliedProfiles, absentCatIds };
  }
}
