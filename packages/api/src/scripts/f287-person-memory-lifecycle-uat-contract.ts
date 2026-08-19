import { createHash } from 'node:crypto';

export const F287_PERSON_MEMORY_FIXTURE_REVISION = 'f287-person-memory-lifecycle-v4' as const;
const ALPHA_API_PORT = '3012';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,48}$/;

export type F287FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type F287JsonRecord = Record<string, unknown>;

export interface F287AlphaOwnerFixture {
  readonly marker: string;
  readonly displayName: string;
  readonly initialFactValue: string;
  readonly correctedFactValue: string;
  readonly relationshipEvidence: string;
  readonly interactionHeadline: string;
  readonly interactionEvidence: string;
  readonly proposalEvidenceText: string;
  readonly sourceText: string;
}

export interface F287PersonMemoryLifecycleUatInput {
  readonly baseUrl: string;
  readonly invocationId: string;
  readonly callbackToken: string;
  readonly ownerUserId: string;
  readonly runId: string;
  readonly fetchImpl?: F287FetchLike;
}

export interface F287PersonMemoryLifecycleUatResult {
  readonly fixtureRevision: typeof F287_PERSON_MEMORY_FIXTURE_REVISION;
  readonly environment: 'alpha';
  readonly proposalId: string;
  readonly personId: string;
  readonly statuses: {
    readonly proposal: string;
    readonly approval: string;
    readonly firstRecall: 'resolved';
    readonly correction: 'applied';
    readonly updatedRecall: 'resolved';
    readonly forget: 'purged';
    readonly finalRecall: 'not_available';
  };
  readonly selectedDraftCount: number;
  readonly materialized: {
    readonly claimCount: number;
    readonly relationshipCount: number;
    readonly eventCount: number;
  };
  readonly assertions: {
    readonly identityPresent: true;
    readonly relationshipPresent: true;
    readonly interactionPresent: true;
    readonly correctionReplacedClaim: true;
    readonly finalForgetZero: true;
    readonly historicalRejectedAldenCounted: false;
  };
}

export function requireF287Record(value: unknown, step: string): F287JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${step} returned an invalid response shape`);
  }
  return value as F287JsonRecord;
}

export function requireF287String(record: F287JsonRecord, key: string, step: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${step} response is missing ${key}`);
  return value;
}

export function requireF287StringArray(record: F287JsonRecord, key: string, step: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${step} response is missing ${key}`);
  }
  return value as string[];
}

export function optionalF287StringArray(record: F287JsonRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : [];
}

export function validateF287RunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('runId must match [A-Za-z0-9][A-Za-z0-9_-]{2,48}');
  }
  return runId;
}

export function requireF287AlphaOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'http:' || !isLoopback || url.port !== ALPHA_API_PORT) {
    throw new Error('alpha API origin must be http://(127.0.0.1|localhost):3012');
  }
  return url.origin;
}

export function buildF287AlphaOwnerFixture(runId: string): F287AlphaOwnerFixture {
  const safeRunId = validateF287RunId(runId);
  const fixtureKey = String(createHash('sha256').update(safeRunId).digest().readUInt32BE(0) % 1_000_000).padStart(
    6,
    '0',
  );
  const marker = `[F287_ALPHA_ONLY_PERSON_MEMORY:${safeRunId}]`;
  const displayName = `P${fixtureKey}`;
  const initialFactValue = `s${fixtureKey}`;
  const correctedFactValue = `r${fixtureKey}`;
  const relationshipEvidence = 'current collaborator';
  const interactionHeadline = `m${fixtureKey}`;
  const interactionEvidence = `met ${displayName} at ${interactionHeadline}`;
  const proposalEvidenceText = [
    `${displayName} role ${initialFactValue}`,
    relationshipEvidence,
    interactionEvidence,
    'uat',
  ].join('; ');
  return {
    marker,
    displayName,
    initialFactValue,
    correctedFactValue,
    relationshipEvidence,
    interactionHeadline,
    interactionEvidence,
    proposalEvidenceText,
    sourceText: [marker, `${proposalEvidenceText}.`].join('\n'),
  };
}

async function responseJson(response: Response, step: string): Promise<F287JsonRecord> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errorCode =
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'request_failed';
    throw new Error(`${step} failed with HTTP ${response.status}: ${errorCode}`);
  }
  return requireF287Record(payload, step);
}

export async function f287CallbackRequest(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  step: string,
  path: string,
  method: 'GET' | 'POST',
  body?: F287JsonRecord,
): Promise<F287JsonRecord> {
  const response = await (input.fetchImpl ?? fetch)(new URL(path, origin), {
    method,
    headers: {
      'content-type': 'application/json',
      'x-invocation-id': input.invocationId,
      'x-callback-token': input.callbackToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return responseJson(response, step);
}

export async function f287OwnerRequest(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  step: string,
  path: string,
  body: F287JsonRecord,
): Promise<F287JsonRecord> {
  const response = await (input.fetchImpl ?? fetch)(new URL(path, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cat-cafe-user': input.ownerUserId },
    body: JSON.stringify(body),
  });
  return responseJson(response, step);
}
