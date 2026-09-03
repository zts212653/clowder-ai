export const PROVIDER_SEMANTIC_EVENT_KINDS = [
  'plan',
  'diff',
  'reasoning',
  'warning',
  'guardian',
  'capability',
  'goal',
  'review',
] as const;

export type ProviderSemanticEventKind = (typeof PROVIDER_SEMANTIC_EVENT_KINDS)[number];

export interface ProviderSemanticProvenance {
  provider: string;
  carrier?: 'native' | 'app_server' | 'exec' | 'callback' | 'history' | 'unknown';
  nativeType?: string;
}

interface ProviderSemanticBase {
  v: 1;
  id: string;
  kind: ProviderSemanticEventKind;
  occurredAt: number;
  invocationId?: string;
  provenance?: ProviderSemanticProvenance;
}

export interface ProviderPlanSemanticEvent extends ProviderSemanticBase {
  kind: 'plan';
  stage: 'started' | 'updated' | 'completed';
  text: string;
  completedItems?: number;
  totalItems?: number;
}

export interface ProviderDiffSemanticEvent extends ProviderSemanticBase {
  kind: 'diff';
  stage: 'updated' | 'completed';
  summary: string;
  files?: ReadonlyArray<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }>;
}

export interface ProviderReasoningSemanticEvent extends ProviderSemanticBase {
  kind: 'reasoning';
  summary: string;
}

export interface ProviderWarningSemanticEvent extends ProviderSemanticBase {
  kind: 'warning';
  category: 'warning' | 'deprecation' | 'model_reroute' | 'safety';
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ProviderGuardianSemanticEvent extends ProviderSemanticBase {
  kind: 'guardian';
  stage: 'started' | 'completed' | 'strict_review_required';
  summary: string;
  outcome?: 'pass' | 'fail' | 'unavailable';
}

export interface ProviderCapabilitySemanticEvent extends ProviderSemanticBase {
  kind: 'capability';
  capability: string;
  availability: 'available' | 'limited' | 'unavailable';
  source: string;
  observedAt: number;
  reason?: string;
}

export interface ProviderGoalSemanticEvent extends ProviderSemanticBase {
  kind: 'goal';
  state: 'updated' | 'cleared';
  revision: number;
  objective?: string;
  status?: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  source: string;
  observedAt: number;
}

export type ProviderReviewStage =
  | 'started'
  | 'mode_entered'
  | 'progress'
  | 'finding'
  | 'result'
  | 'failed'
  | 'mode_exited';

export type ProviderReviewTarget =
  | { kind: 'uncommitted_changes' }
  | { kind: 'base_branch'; branch: string }
  | { kind: 'commit'; sha: string; title?: string }
  | { kind: 'custom'; instructions: string };

export interface ProviderReviewSemanticEvent extends ProviderSemanticBase {
  kind: 'review';
  reviewId: string;
  actorCatId?: string;
  stage: ProviderReviewStage;
  summary: string;
  requestedAt?: number;
  targetLabel?: string;
  target?: ProviderReviewTarget;
  delivery?: 'inline' | 'detached';
  reviewThreadId?: string;
  turnId?: string;
  filePath?: string;
  severity?: 'info' | 'warning' | 'error';
  errorCode?: string;
}

export type ProviderSemanticEvent =
  | ProviderPlanSemanticEvent
  | ProviderDiffSemanticEvent
  | ProviderReasoningSemanticEvent
  | ProviderWarningSemanticEvent
  | ProviderGuardianSemanticEvent
  | ProviderCapabilitySemanticEvent
  | ProviderGoalSemanticEvent
  | ProviderReviewSemanticEvent;

const semanticKinds = new Set<string>(PROVIDER_SEMANTIC_EVENT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const COMMON_KEYS = ['v', 'id', 'kind', 'occurredAt', 'invocationId', 'provenance'] as const;

function hasOnlySemanticKeys(value: Record<string, unknown>, kindKeys: readonly string[]): boolean {
  return hasOnlyKeys(value, [...COMMON_KEYS, ...kindKeys]);
}

function hasValidProvenance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isNonEmptyString(value.provider)) return false;
  if (!hasOnlyKeys(value, ['provider', 'carrier', 'nativeType'])) return false;
  if (value.nativeType !== undefined && !isNonEmptyString(value.nativeType)) return false;
  return (
    value.carrier === undefined ||
    isOneOf(value.carrier, ['native', 'app_server', 'exec', 'callback', 'history', 'unknown'] as const)
  );
}

function hasValidCommon(value: Record<string, unknown>): boolean {
  return (
    value.v === 1 &&
    isNonEmptyString(value.id) &&
    isFiniteNumber(value.occurredAt) &&
    isOneOf(value.kind, PROVIDER_SEMANTIC_EVENT_KINDS) &&
    (value.invocationId === undefined || isNonEmptyString(value.invocationId)) &&
    hasValidProvenance(value.provenance)
  );
}

type SemanticPayloadValidator = (value: Record<string, unknown>) => boolean;

const semanticPayloadValidators: Record<ProviderSemanticEventKind, SemanticPayloadValidator> = {
  plan: (value) =>
    hasOnlySemanticKeys(value, ['stage', 'text', 'completedItems', 'totalItems']) &&
    isOneOf(value.stage, ['started', 'updated', 'completed'] as const) &&
    isNonEmptyString(value.text) &&
    isOptionalNonNegativeInteger(value.completedItems) &&
    isOptionalNonNegativeInteger(value.totalItems),
  diff: (value) =>
    hasOnlySemanticKeys(value, ['stage', 'summary', 'files']) &&
    isOneOf(value.stage, ['updated', 'completed'] as const) &&
    isNonEmptyString(value.summary) &&
    hasValidDiffFiles(value.files),
  reasoning: (value) => hasOnlySemanticKeys(value, ['summary']) && isNonEmptyString(value.summary),
  warning: (value) =>
    hasOnlySemanticKeys(value, ['category', 'severity', 'message']) &&
    isOneOf(value.category, ['warning', 'deprecation', 'model_reroute', 'safety'] as const) &&
    isOneOf(value.severity, ['info', 'warning', 'error'] as const) &&
    isNonEmptyString(value.message),
  guardian: (value) =>
    hasOnlySemanticKeys(value, ['stage', 'summary', 'outcome']) &&
    isOneOf(value.stage, ['started', 'completed', 'strict_review_required'] as const) &&
    isNonEmptyString(value.summary) &&
    (value.outcome === undefined || isOneOf(value.outcome, ['pass', 'fail', 'unavailable'] as const)),
  capability: (value) =>
    hasOnlySemanticKeys(value, ['capability', 'availability', 'source', 'observedAt', 'reason']) &&
    isNonEmptyString(value.capability) &&
    isOneOf(value.availability, ['available', 'limited', 'unavailable'] as const) &&
    isNonEmptyString(value.source) &&
    isFiniteNumber(value.observedAt) &&
    (value.reason === undefined || isNonEmptyString(value.reason)),
  goal: (value) =>
    hasOnlySemanticKeys(value, ['state', 'revision', 'objective', 'status', 'source', 'observedAt']) &&
    isOneOf(value.state, ['updated', 'cleared'] as const) &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    isNonEmptyString(value.source) &&
    isFiniteNumber(value.observedAt) &&
    (value.status === undefined ||
      isOneOf(value.status, ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const)) &&
    (value.state === 'cleared' || isNonEmptyString(value.objective)),
  review: (value) =>
    hasOnlySemanticKeys(value, [
      'reviewId',
      'actorCatId',
      'stage',
      'summary',
      'requestedAt',
      'targetLabel',
      'target',
      'delivery',
      'reviewThreadId',
      'turnId',
      'filePath',
      'severity',
      'errorCode',
    ]) &&
    isNonEmptyString(value.reviewId) &&
    (value.actorCatId === undefined || isNonEmptyString(value.actorCatId)) &&
    isOneOf(value.stage, [
      'started',
      'mode_entered',
      'progress',
      'finding',
      'result',
      'failed',
      'mode_exited',
    ] as const) &&
    isNonEmptyString(value.summary) &&
    (value.requestedAt === undefined || isFiniteNumber(value.requestedAt)) &&
    hasValidReviewTarget(value.target) &&
    (value.targetLabel === undefined || isNonEmptyString(value.targetLabel)) &&
    (value.delivery === undefined || isOneOf(value.delivery, ['inline', 'detached'] as const)) &&
    (value.reviewThreadId === undefined || isNonEmptyString(value.reviewThreadId)) &&
    (value.turnId === undefined || isNonEmptyString(value.turnId)) &&
    (value.filePath === undefined || isNonEmptyString(value.filePath)) &&
    (value.severity === undefined || isOneOf(value.severity, ['info', 'warning', 'error'] as const)) &&
    (value.errorCode === undefined || isNonEmptyString(value.errorCode)),
};

function hasValidKindPayload(value: Record<string, unknown>): boolean {
  const kind = value.kind;
  return (
    typeof kind === 'string' &&
    semanticKinds.has(kind) &&
    semanticPayloadValidators[kind as ProviderSemanticEventKind](value)
  );
}

function hasValidReviewTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.kind === 'uncommitted_changes') return hasOnlyKeys(value, ['kind']);
  if (value.kind === 'base_branch') return hasOnlyKeys(value, ['kind', 'branch']) && isNonEmptyString(value.branch);
  if (value.kind === 'commit') {
    return (
      hasOnlyKeys(value, ['kind', 'sha', 'title']) &&
      isNonEmptyString(value.sha) &&
      (value.title === undefined || isNonEmptyString(value.title))
    );
  }
  if (value.kind === 'custom') {
    return hasOnlyKeys(value, ['kind', 'instructions']) && isNonEmptyString(value.instructions);
  }
  return false;
}

function hasValidDiffFiles(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        hasOnlyKeys(file, ['path', 'status']) &&
        isNonEmptyString(file.path) &&
        isOneOf(file.status, ['added', 'modified', 'deleted', 'renamed'] as const),
    )
  );
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

export function normalizeThreadGoalObjective(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 4_000 ? normalized : null;
}

export function isProviderSemanticEvent(value: unknown): value is ProviderSemanticEvent {
  if (!isRecord(value) || !semanticKinds.has(String(value.kind))) return false;
  return hasValidCommon(value) && hasValidKindPayload(value);
}
