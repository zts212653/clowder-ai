import { type CallbackPrincipal, type CatId, catRegistry } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../stores/ports/ThreadStore.js';
import {
  appendRuntimeIdentity,
  type RuntimeSessionExternalRegistrationBinding,
  type RuntimeSessionMetadata,
  type RuntimeSessionRuntime,
} from './RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from './RuntimeSessionStore.js';

export const EXTERNAL_RUNTIME_REGISTRATION_RUNTIMES = ['antigravity-desktop'] as const;
export type ExternalRuntimeRegistrationRuntime = (typeof EXTERNAL_RUNTIME_REGISTRATION_RUNTIMES)[number];

export type ExternalRuntimeSessionBindingInput = { mode: 'orphan' } | { mode: 'thread'; threadId: string };

export interface ExternalRuntimeSessionProvenance {
  source: 'antigravity-ide-direct';
  agentKeyId: string;
  registeredAt: number;
  ideWindowId?: string;
  workspacePath?: string;
  runtimeUrl?: string;
  note?: string;
}

export interface ExternalRuntimeSessionRegistrationInput {
  runtime: ExternalRuntimeRegistrationRuntime;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  catId: CatId;
  model: string;
  title?: string;
  startedAt: number;
  lastObservedAt: number;
  binding: ExternalRuntimeSessionBindingInput;
  bindingWasProvided: boolean;
  provenance: ExternalRuntimeSessionProvenance;
  clientRegistrationId?: string;
}

export interface ExternalRuntimeSessionRegistrationOptions {
  now?: number;
}

export interface ExternalRuntimeSessionRegistrationDeps {
  sessionChainStore: ISessionChainStore;
  runtimeSessionStore: IRuntimeSessionStore;
  threadStore: IThreadStore;
  now?: () => number;
}

interface ResolvedExternalRuntimeBinding {
  threadId: string;
  binding: RuntimeSessionExternalRegistrationBinding;
}

export interface ExternalRuntimeSessionRegistrationResult {
  status: 'created' | 'updated';
  sessionId: string;
  threadId: string;
  runtime: ExternalRuntimeRegistrationRuntime;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  catId: CatId;
  binding: RuntimeSessionExternalRegistrationBinding;
  drilldown: {
    sessionRecord: `/api/sessions/${string}`;
    events: `/api/sessions/${string}/events`;
    digest: `/api/sessions/${string}/digest`;
  };
}

export class ExternalRuntimeSessionRegistrationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message = code,
  ) {
    super(message);
    this.name = 'ExternalRuntimeSessionRegistrationError';
  }
}

const externalRuntimeRegistrationLocks = new Map<string, Promise<void>>();

export function normalizeExternalRuntimeSessionRegistration(
  input: unknown,
  principal: CallbackPrincipal,
  options: ExternalRuntimeSessionRegistrationOptions = {},
): ExternalRuntimeSessionRegistrationInput {
  if (principal.kind !== 'agent_key') {
    throw new Error('external runtime registration requires agent-key principal');
  }

  const record = requireRecord(input, 'external runtime session registration');
  const catId = requireNonEmptyString(record.catId, 'catId');
  if (catId !== principal.catId) {
    throw new Error('payload catId must match agent-key principal');
  }
  if (!catRegistry.has(catId)) {
    throw new Error(`invalid catId: ${catId}`);
  }

  const runtime = requireRuntime(record.runtime);
  const startedAt = requireFiniteNumber(record.startedAt, 'startedAt');
  const lastObservedAt =
    record.lastObservedAt === undefined ? startedAt : requireFiniteNumber(record.lastObservedAt, 'lastObservedAt');
  if (lastObservedAt < startedAt) {
    throw new Error('lastObservedAt must not precede startedAt');
  }

  return {
    runtime,
    runtimeSessionId: requireNonEmptyString(record.runtimeSessionId, 'runtimeSessionId'),
    ...optionalStringField(record.runtimeConversationId, 'runtimeConversationId'),
    catId: catId as CatId,
    model: requireNonEmptyString(record.model, 'model'),
    ...optionalStringField(record.title, 'title'),
    startedAt,
    lastObservedAt,
    binding: normalizeBinding(record.binding),
    bindingWasProvided: record.binding !== undefined,
    provenance: normalizeProvenance(record.provenance, principal.agentKeyId, options.now ?? Date.now()),
    ...optionalStringField(record.clientRegistrationId, 'clientRegistrationId'),
  };
}

export async function registerExternalRuntimeSession(
  input: unknown,
  principal: CallbackPrincipal,
  deps: ExternalRuntimeSessionRegistrationDeps,
): Promise<ExternalRuntimeSessionRegistrationResult> {
  if (principal.kind !== 'agent_key') {
    throw new Error('external runtime registration requires agent-key principal');
  }
  const now = deps.now?.() ?? Date.now();
  const registration = normalizeExternalRuntimeSessionRegistration(input, principal, { now });
  return withExternalRuntimeRegistrationLock(registration.runtime, registration.runtimeSessionId, () =>
    registerExternalRuntimeSessionLocked(registration, principal, deps, now),
  );
}

async function registerExternalRuntimeSessionLocked(
  registration: ExternalRuntimeSessionRegistrationInput,
  principal: Extract<CallbackPrincipal, { kind: 'agent_key' }>,
  deps: ExternalRuntimeSessionRegistrationDeps,
  now: number,
): Promise<ExternalRuntimeSessionRegistrationResult> {
  const existing = await deps.runtimeSessionStore.getByRuntimeSession(
    registration.runtime,
    registration.runtimeSessionId,
  );

  if (existing) {
    const existingRecord = await deps.sessionChainStore.get(existing.sessionId);
    const existingThreadId = resolveExistingThreadId(existing, existingRecord?.threadId);
    const binding = registration.bindingWasProvided
      ? await resolveBinding(registration, principal, deps.threadStore)
      : resolveExistingBinding(existing, existingThreadId);
    if (existing.catId !== registration.catId || (existingRecord && existingRecord.catId !== registration.catId)) {
      throw new ExternalRuntimeSessionRegistrationError(
        'external_runtime_cat_immutable',
        409,
        'external_runtime_cat_immutable',
      );
    }
    if (existing.userId !== principal.userId || (existingRecord && existingRecord.userId !== principal.userId)) {
      throw new ExternalRuntimeSessionRegistrationError(
        'external_runtime_user_immutable',
        409,
        'external_runtime_user_immutable',
      );
    }
    if (existingThreadId !== binding.threadId || (existing.threadId && existing.threadId !== binding.threadId)) {
      throw new ExternalRuntimeSessionRegistrationError(
        'external_runtime_binding_immutable',
        409,
        'external_runtime_binding_immutable',
      );
    }

    const metadata = buildUpdatedMetadata(existing, registration, principal.userId, binding.binding);
    await deps.runtimeSessionStore.upsert(metadata);
    return buildResult('updated', metadata, binding.binding);
  }

  const binding = await resolveBinding(registration, principal, deps.threadStore);
  const sessionRecord = await deps.sessionChainStore.create({
    cliSessionId: registration.runtimeSessionId,
    threadId: binding.threadId,
    catId: registration.catId,
    userId: principal.userId,
    reuseExistingCliSession: true,
  });
  assertSessionRecordCompatible(sessionRecord, registration, binding.threadId, principal.userId);
  await reopenFailedExternalRegistrationSessionRecord(sessionRecord, deps.sessionChainStore, now);
  const claimedMetadata = await deps.runtimeSessionStore.getByRuntimeSession(
    registration.runtime,
    registration.runtimeSessionId,
  );
  if (claimedMetadata) {
    assertRuntimeMetadataCompatible(
      claimedMetadata,
      sessionRecord.id,
      registration,
      binding.threadId,
      principal.userId,
    );
  }
  const metadata = claimedMetadata
    ? buildUpdatedMetadata(claimedMetadata, registration, principal.userId, binding.binding)
    : buildNewMetadata(sessionRecord.id, registration, principal.userId, binding.threadId, binding.binding);

  try {
    await deps.runtimeSessionStore.upsert(metadata);
  } catch (err) {
    await deps.sessionChainStore.update(sessionRecord.id, {
      status: 'sealed',
      sealReason: 'external_registration_failed',
      sealedAt: now,
    });
    throw err;
  }

  return buildResult(claimedMetadata ? 'updated' : 'created', metadata, binding.binding);
}

function resolveExistingThreadId(metadata: RuntimeSessionMetadata, sessionRecordThreadId?: string): string {
  if (sessionRecordThreadId) return sessionRecordThreadId;
  if (metadata.threadId) return metadata.threadId;
  const binding = metadata.externalRegistration?.binding;
  if (binding) return binding.mode === 'orphan_anchor' ? binding.anchorThreadId : binding.threadId;
  throw new ExternalRuntimeSessionRegistrationError(
    'external_runtime_binding_immutable',
    409,
    'external_runtime_binding_immutable',
  );
}

function resolveExistingBinding(metadata: RuntimeSessionMetadata, threadId: string): ResolvedExternalRuntimeBinding {
  if (metadata.externalRegistration?.binding) {
    const binding = metadata.externalRegistration.binding;
    return {
      threadId: binding.mode === 'orphan_anchor' ? binding.anchorThreadId : binding.threadId,
      binding,
    };
  }
  return {
    threadId,
    binding: { mode: 'thread', threadId, requestedBy: 'agent_key' },
  };
}

async function withExternalRuntimeRegistrationLock<T>(
  runtime: RuntimeSessionRuntime,
  runtimeSessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${runtime}:${runtimeSessionId}`;
  const previous = externalRuntimeRegistrationLocks.get(key) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(
    () => current,
    () => current,
  );
  externalRuntimeRegistrationLocks.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release!();
    if (externalRuntimeRegistrationLocks.get(key) === next) {
      externalRuntimeRegistrationLocks.delete(key);
    }
  }
}

async function reopenFailedExternalRegistrationSessionRecord(
  sessionRecord: Awaited<ReturnType<ISessionChainStore['create']>>,
  sessionChainStore: ISessionChainStore,
  now: number,
): Promise<void> {
  if (sessionRecord.status === 'active') return;
  if (sessionRecord.sealReason !== 'external_registration_failed') {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_session_record_inactive',
      409,
      'external_runtime_session_record_inactive',
    );
  }
  const reopened = await sessionChainStore.update(sessionRecord.id, {
    status: 'active',
    sealReason: null,
    sealedAt: null,
    updatedAt: now,
  });
  if (!reopened || reopened.status !== 'active') {
    throw new Error('external_runtime_session_record_reopen_failed');
  }
}

function assertSessionRecordCompatible(
  sessionRecord: Awaited<ReturnType<ISessionChainStore['create']>>,
  registration: ExternalRuntimeSessionRegistrationInput,
  threadId: string,
  userId: string,
): void {
  if (sessionRecord.catId !== registration.catId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_cat_immutable',
      409,
      'external_runtime_cat_immutable',
    );
  }
  if (sessionRecord.userId !== userId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_user_immutable',
      409,
      'external_runtime_user_immutable',
    );
  }
  if (sessionRecord.threadId !== threadId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_binding_immutable',
      409,
      'external_runtime_binding_immutable',
    );
  }
}

function assertRuntimeMetadataCompatible(
  metadata: RuntimeSessionMetadata,
  sessionId: string,
  registration: ExternalRuntimeSessionRegistrationInput,
  threadId: string,
  userId: string,
): void {
  if (metadata.sessionId !== sessionId || metadata.catId !== registration.catId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_cat_immutable',
      409,
      'external_runtime_cat_immutable',
    );
  }
  if (metadata.userId !== userId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_user_immutable',
      409,
      'external_runtime_user_immutable',
    );
  }
  if (metadata.threadId !== threadId) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_binding_immutable',
      409,
      'external_runtime_binding_immutable',
    );
  }
}

async function resolveBinding(
  registration: ExternalRuntimeSessionRegistrationInput,
  principal: Extract<CallbackPrincipal, { kind: 'agent_key' }>,
  threadStore: IThreadStore,
): Promise<ResolvedExternalRuntimeBinding> {
  if (registration.binding.mode === 'orphan') {
    const anchor = await threadStore.ensureExternalRuntimeAnchorThread(registration.runtime, principal.userId);
    return {
      threadId: anchor.id,
      binding: { mode: 'orphan_anchor', anchorThreadId: anchor.id },
    };
  }

  const thread = await threadStore.get(registration.binding.threadId);
  if (!thread || !canBindExternalRuntimeSessionToThread(thread, principal.userId)) {
    throw new ExternalRuntimeSessionRegistrationError(
      'external_runtime_thread_forbidden',
      403,
      'external_runtime_thread_forbidden',
    );
  }
  return {
    threadId: thread.id,
    binding: { mode: 'thread', threadId: thread.id, requestedBy: 'agent_key' },
  };
}

function canBindExternalRuntimeSessionToThread(thread: { id: string; createdBy: string }, userId: string): boolean {
  if (thread.createdBy === userId) return true;
  return thread.id === DEFAULT_THREAD_ID && thread.createdBy === 'system';
}

function buildNewMetadata(
  sessionId: string,
  registration: ExternalRuntimeSessionRegistrationInput,
  userId: string,
  threadId: string,
  binding: RuntimeSessionExternalRegistrationBinding,
): RuntimeSessionMetadata {
  return {
    sessionId,
    runtime: registration.runtime,
    runtimeSessionId: registration.runtimeSessionId,
    ...optionalStringField(registration.runtimeConversationId, 'runtimeConversationId'),
    threadId,
    catId: registration.catId,
    userId,
    surface: 'ide-direct',
    identityHistory: [
      {
        catId: registration.catId,
        model: registration.model,
        from: registration.startedAt,
        source: 'external_registration',
      },
    ],
    lifecycle: {
      state: 'active',
      startedAt: registration.startedAt,
      lastObservedAt: registration.lastObservedAt,
    },
    externalRegistration: {
      binding,
      provenance: registration.provenance,
      ...optionalStringField(registration.title, 'title'),
      ...optionalStringField(registration.clientRegistrationId, 'clientRegistrationId'),
    },
  };
}

function buildUpdatedMetadata(
  existing: RuntimeSessionMetadata,
  registration: ExternalRuntimeSessionRegistrationInput,
  userId: string,
  binding: RuntimeSessionExternalRegistrationBinding,
): RuntimeSessionMetadata {
  const observedAt = Math.max(existing.lifecycle.lastObservedAt, registration.lastObservedAt);
  const registrationIsCurrent = registration.lastObservedAt >= existing.lifecycle.lastObservedAt;
  const metadata: RuntimeSessionMetadata = {
    ...existing,
    ...(registrationIsCurrent ? optionalStringField(registration.runtimeConversationId, 'runtimeConversationId') : {}),
    catId: registration.catId,
    userId,
    surface: 'ide-direct',
    lifecycle: {
      ...existing.lifecycle,
      state: registrationIsCurrent ? 'active' : existing.lifecycle.state,
      startedAt: Math.min(existing.lifecycle.startedAt, registration.startedAt),
      lastObservedAt: observedAt,
    },
    externalRegistration:
      registrationIsCurrent || !existing.externalRegistration
        ? buildUpdatedExternalRegistration(existing, registration, binding)
        : existing.externalRegistration,
  };
  if (!registrationIsCurrent) return metadata;
  const currentIdentity = metadata.identityHistory.at(-1);
  if (
    !currentIdentity ||
    currentIdentity.catId !== registration.catId ||
    currentIdentity.model !== registration.model
  ) {
    return appendRuntimeIdentity(metadata, {
      catId: registration.catId,
      model: registration.model,
      from: Math.max(registration.lastObservedAt, currentIdentity?.from ?? registration.startedAt),
      source: 'external_registration',
    });
  }
  return metadata;
}

function buildUpdatedExternalRegistration(
  existing: RuntimeSessionMetadata,
  registration: ExternalRuntimeSessionRegistrationInput,
  binding: RuntimeSessionExternalRegistrationBinding,
): RuntimeSessionMetadata['externalRegistration'] {
  return {
    ...existing.externalRegistration,
    binding,
    provenance: registration.provenance,
    ...optionalStringField(registration.title, 'title'),
    ...optionalStringField(registration.clientRegistrationId, 'clientRegistrationId'),
  };
}

function buildResult(
  status: 'created' | 'updated',
  metadata: RuntimeSessionMetadata,
  binding: RuntimeSessionExternalRegistrationBinding,
): ExternalRuntimeSessionRegistrationResult {
  const sessionId = metadata.sessionId;
  const threadId = metadata.threadId ?? (binding.mode === 'orphan_anchor' ? binding.anchorThreadId : binding.threadId);
  return {
    status,
    sessionId,
    threadId,
    runtime: metadata.runtime,
    runtimeSessionId: metadata.runtimeSessionId,
    ...optionalStringField(metadata.runtimeConversationId, 'runtimeConversationId'),
    catId: metadata.catId,
    binding,
    drilldown: {
      sessionRecord: `/api/sessions/${sessionId}`,
      events: `/api/sessions/${sessionId}/events`,
      digest: `/api/sessions/${sessionId}/digest`,
    },
  };
}

function normalizeBinding(input: unknown): ExternalRuntimeSessionBindingInput {
  if (input === undefined) return { mode: 'orphan' };
  const record = requireRecord(input, 'binding');
  const mode = requireNonEmptyString(record.mode, 'binding.mode');
  if (mode === 'orphan') return { mode };
  if (mode === 'thread') {
    return {
      mode,
      threadId: requireNonEmptyString(record.threadId, 'binding.threadId'),
    };
  }
  throw new Error('invalid binding.mode');
}

function normalizeProvenance(
  input: unknown,
  agentKeyId: string,
  registeredAt: number,
): ExternalRuntimeSessionProvenance {
  if (input === undefined) {
    return {
      source: 'antigravity-ide-direct',
      agentKeyId,
      registeredAt,
    };
  }

  const record = requireRecord(input, 'provenance');
  const source =
    record.source === undefined ? 'antigravity-ide-direct' : requireNonEmptyString(record.source, 'source');
  if (source !== 'antigravity-ide-direct') {
    throw new Error('invalid provenance.source');
  }

  return {
    source,
    agentKeyId,
    registeredAt,
    ...optionalStringField(record.ideWindowId, 'ideWindowId'),
    ...optionalStringField(record.workspacePath, 'workspacePath'),
    ...optionalStringField(record.runtimeUrl, 'runtimeUrl'),
    ...optionalStringField(record.note, 'note'),
  };
}

function requireRuntime(value: unknown): ExternalRuntimeRegistrationRuntime {
  if (
    typeof value !== 'string' ||
    !EXTERNAL_RUNTIME_REGISTRATION_RUNTIMES.includes(value as ExternalRuntimeRegistrationRuntime)
  ) {
    throw new Error('invalid external runtime');
  }
  return value as RuntimeSessionRuntime;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function optionalStringField(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  return { [name]: requireNonEmptyString(value, name) };
}
