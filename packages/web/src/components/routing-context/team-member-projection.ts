import type { CapabilityProfileRevisionRefV1, RoutingContextSnapshotV1 } from '@cat-cafe/shared';

type Candidate = RoutingContextSnapshotV1['candidates'][number];
type Availability = Candidate['availability'];
type RelevantSignal = CapabilityProfileRevisionRefV1['relevantSignals'][number];

/**
 * F293 AC-UX1/UX2 — the Team surface reads two different truths and must not blend them:
 * identity comes from the canonical cat catalog presentation join, capability comes only
 * from the F208 applied dossier revision carried by the routing snapshot. Nothing here
 * derives capability from a model name, a provider id, or an availability signal.
 */

/** Signal kinds that answer "what is this partner good for". */
const FIT_KINDS: ReadonlySet<RelevantSignal['kind']> = new Set(['strength', 'underused_strength', 'summon_signal']);
/** Signal kinds that answer "what to watch out for when working together". */
const WATCH_KINDS: ReadonlySet<RelevantSignal['kind']> = new Set(['anti_signal', 'hard_limit']);

const SUMMARY_SIGNAL_LIMIT = 3;

export const ABSENT_PROFILE_SUMMARY = '能力资料待补充';
export const EMPTY_FIT_SUMMARY = '画像里还没有可读的长处摘要';

export type TeamAvailabilityTone = 'ok' | 'attention' | 'blocked' | 'unknown';

export interface TeamAvailabilityReading {
  availability: Availability;
  label: string;
  tone: TeamAvailabilityTone;
  /** One sentence saying what this state does and does not mean before handing work over. */
  impact: string;
  /**
   * F293 #4383 — an automatically unavailable target can still be attempted by a trusted
   * owner; RoutingPreflightService downgrades that case to `warned` with `ownerAttempt`.
   * Absent dispatch context is never read as permission.
   */
  ownerAttemptAllowed: boolean;
}

type AvailabilityCopy = Omit<TeamAvailabilityReading, 'availability' | 'ownerAttemptAllowed'>;

const AVAILABILITY_READINGS: Record<Availability, AvailabilityCopy> = {
  available: {
    label: '可接任务',
    tone: 'ok',
    impact: '目前没有已知限制。可接任务不等于在线、空闲或已经接责。',
  },
  scarce: {
    label: '供给偏紧',
    tone: 'attention',
    impact: '这只猫的可用供给比平常少，仍然可以发送，但值得先看看别的伙伴。',
  },
  degraded: {
    label: '运行受限',
    tone: 'attention',
    impact: '当前运行环境低于平常，复杂任务可能受影响。这说的是此刻的运行状态，不是长期能力。',
  },
  unavailable: {
    label: '暂不可用',
    tone: 'blocked',
    impact: '现在发送会被拒绝，等状态恢复或改找别的伙伴。',
  },
  unknown: {
    label: '状态待确认',
    tone: 'unknown',
    impact: '暂时读不到当前状态。这既不代表可用，也不代表不可用。',
  },
};

/** Impact copy for an automatically unavailable target a trusted owner may still try. */
const OWNER_ATTEMPT_IMPACT = '自动协作会跳过他。你仍然可以带着告警亲自尝试一次，成功与否都会留下回执。';

export function readTeamAvailability(
  availability: Availability,
  dispatch?: Candidate['dispatch'],
): TeamAvailabilityReading {
  const ownerAttemptAllowed = availability === 'unavailable' && dispatch?.ownerAttemptAllowed === true;
  return {
    availability,
    ...AVAILABILITY_READINGS[availability],
    ...(ownerAttemptAllowed ? { impact: OWNER_ATTEMPT_IMPACT } : {}),
    ownerAttemptAllowed,
  };
}

export type TeamCapabilityReading =
  | {
      state: 'applied';
      summary: string;
      /** Signals that answer "when is it right to hand this to them". */
      fitSignals: string[];
      /** Signals that answer "what to keep in mind while working together". */
      watchOuts: string[];
      revision: CapabilityProfileRevisionRefV1;
    }
  | { state: 'absent'; summary: string };

export function readTeamCapability(candidate: Candidate): TeamCapabilityReading {
  if (candidate.profile.state !== 'applied') return { state: 'absent', summary: ABSENT_PROFILE_SUMMARY };
  const revision = candidate.profile.revision;
  const fitSignals = revision.relevantSignals.filter((signal) => FIT_KINDS.has(signal.kind)).map((s) => s.summary);
  const watchOuts = revision.relevantSignals.filter((signal) => WATCH_KINDS.has(signal.kind)).map((s) => s.summary);
  return {
    state: 'applied',
    summary: fitSignals.length > 0 ? fitSignals.slice(0, SUMMARY_SIGNAL_LIMIT).join(' · ') : EMPTY_FIT_SUMMARY,
    fitSignals,
    watchOuts,
    revision,
  };
}

/**
 * The narrow slice of the real GET /api/cats payload the Team surface presents.
 * `displayName` there carries the breed + variant name ("缅因猫 Terra"); the human
 * nickname the accepted layout leads with lives in its own field.
 */
export interface TeamIdentitySource {
  displayName: string;
  nickname?: string;
  variantLabel?: string;
  breedDisplayName?: string;
  defaultModel?: string;
}

export interface TeamMemberIdentity {
  catId: string;
  /** Nickname when the catalog has one, else the canonical display name. */
  displayName: string;
  /** Breed / variant / model line; null when the member is not in the canonical catalog. */
  secondaryLabel: string | null;
}

/** "GPT-5.6 Terra" and "gpt-5.6-terra" are the same fact written twice. */
function identityKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s._-]+/g, '');
}

/**
 * De-duplicate right-biased: when a variant label and a model id are the same fact
 * ("GPT-5.6 Terra" / "gpt-5.6-terra") the precise model id survives. A variant that
 * carries extra meaning ("Gemini 3.1 Pro (High)") is not the same fact and stays.
 * The primary line counts as already said — a member without a nickname must not
 * read its own display name twice.
 */
function dedupeSecondaryParts(parts: readonly (string | undefined)[], primary: string): string[] {
  const kept: string[] = [];
  const seen = new Set<string>([identityKey(primary)]);
  for (const part of [...parts].reverse()) {
    if (!part) continue;
    const key = identityKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.unshift(part);
  }
  return kept;
}

export function buildTeamMemberIdentity(catId: string, cat: TeamIdentitySource | undefined): TeamMemberIdentity {
  if (!cat) return { catId, displayName: catId, secondaryLabel: null };
  const displayName = cat.nickname?.trim() || cat.displayName;
  const breedLabel = cat.breedDisplayName ?? cat.displayName;
  const secondary = dedupeSecondaryParts([breedLabel, cat.variantLabel, cat.defaultModel], displayName).join(' · ');
  return { catId, displayName, secondaryLabel: secondary || null };
}

export interface TeamMemberRow {
  candidate: Candidate;
  identity: TeamMemberIdentity;
  capability: TeamCapabilityReading;
  availability: TeamAvailabilityReading;
}

export function toTeamMemberRow(candidate: Candidate, cat: TeamIdentitySource | undefined): TeamMemberRow {
  return {
    candidate,
    identity: buildTeamMemberIdentity(candidate.binding.catId, cat),
    capability: readTeamCapability(candidate),
    availability: readTeamAvailability(candidate.availability, candidate.dispatch),
  };
}

export type TeamMemberFilter = 'all' | 'attention' | 'absent';

function matchesFilter(row: TeamMemberRow, filter: TeamMemberFilter): boolean {
  if (filter === 'attention') return row.availability.tone !== 'ok';
  if (filter === 'absent') return row.capability.state === 'absent';
  return true;
}

function searchCorpus(row: TeamMemberRow): string {
  const fit = row.capability.state === 'applied' ? row.capability.fitSignals : [];
  return [
    row.identity.displayName,
    row.identity.catId,
    row.identity.secondaryLabel ?? '',
    row.capability.summary,
    ...fit,
  ]
    .join(' ')
    .toLocaleLowerCase();
}

/** Explainable narrowing only — the roster order from the canonical catalog is never resorted. */
export function filterTeamMembers(
  rows: readonly TeamMemberRow[],
  { query, filter }: { query: string; filter: TeamMemberFilter },
): TeamMemberRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => matchesFilter(row, filter) && (needle === '' || searchCorpus(row).includes(needle)));
}

export function countTeamMembers(rows: readonly TeamMemberRow[]): Record<TeamMemberFilter, number> {
  return {
    all: rows.length,
    attention: rows.filter((row) => matchesFilter(row, 'attention')).length,
    absent: rows.filter((row) => matchesFilter(row, 'absent')).length,
  };
}
