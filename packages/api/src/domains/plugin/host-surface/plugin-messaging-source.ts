import type { ConnectorSource } from '@cat-cafe/shared';
import type { IdentityContribution, MessageDraft, PluginManifest } from '@clowder-ai/plugin-contract';
import { MessagingError } from '../../messaging/contract/host-types.js';
import { externalPluginIdentity } from './plugin-external-identity.js';

const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_META_BYTES = 16_384;
const MAX_SOURCE_META_DEPTH = 20;
const MAX_SOURCE_META_VALUES = 2_000;
const HOST_SOURCE_META_KEYS = new Set(['externalChatId']);

export interface PluginMessageSourceInput {
  readonly sender?: unknown;
  readonly identity?: unknown;
  readonly url?: unknown;
  readonly meta?: unknown;
}

export interface PluginMessageSourceResult {
  readonly source: ConnectorSource;
  readonly sender?: { readonly id: string; readonly name?: string };
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new MessagingError('VALIDATION', `${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function senderOf(value: unknown): PluginMessageSourceResult['sender'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'sender must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'id' && key !== 'name')) {
    throw new MessagingError('VALIDATION', 'sender contains unsupported fields');
  }
  return {
    id: boundedString(candidate.id, 'sender.id', 500),
    ...(candidate.name === undefined ? {} : { name: boundedString(candidate.name, 'sender.name', 200) }),
  };
}

function sourceUrlOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = boundedString(value, 'url', MAX_SOURCE_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MessagingError('VALIDATION', 'url must be an absolute http(s) URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new MessagingError('VALIDATION', 'url must be an absolute http(s) URL without credentials');
  }
  return raw;
}

interface SourceMetaValidationState {
  readonly seen: WeakSet<object>;
  values: number;
}

function validateSourceMetaObject(candidate: object, depth: number, state: SourceMetaValidationState): void {
  if (state.seen.has(candidate)) throw new MessagingError('VALIDATION', 'meta must not contain cycles');
  state.seen.add(candidate);
  if (Array.isArray(candidate)) {
    for (const item of candidate) validateSourceMetaValue(item, depth + 1, state);
    return;
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MessagingError('VALIDATION', 'meta must contain only plain JSON objects');
  }
  for (const [key, item] of Object.entries(candidate)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new MessagingError('VALIDATION', `meta key ${key} is reserved`);
    }
    validateSourceMetaValue(item, depth + 1, state);
  }
}

function validateSourceMetaValue(candidate: unknown, depth: number, state: SourceMetaValidationState): void {
  state.values += 1;
  if (state.values > MAX_SOURCE_META_VALUES || depth > MAX_SOURCE_META_DEPTH) {
    throw new MessagingError('VALIDATION', 'meta exceeds the Host complexity limit');
  }
  if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate)) throw new MessagingError('VALIDATION', 'meta numbers must be finite');
    return;
  }
  if (typeof candidate !== 'object') throw new MessagingError('VALIDATION', 'meta must contain only JSON values');
  validateSourceMetaObject(candidate, depth, state);
}

function sourceMetaOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'meta must be a JSON object');
  }
  validateSourceMetaValue(value, 0, { seen: new WeakSet<object>(), values: 0 });
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_META_BYTES) {
    throw new MessagingError('VALIDATION', `meta must be at most ${MAX_SOURCE_META_BYTES} UTF-8 bytes`);
  }
  const cloned = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(cloned)) {
    if (HOST_SOURCE_META_KEYS.has(key)) {
      throw new MessagingError('VALIDATION', `meta.${key} is owned by the Host`);
    }
  }
  return cloned;
}

function authoredIdentity(
  declared: ReadonlyMap<string, IdentityContribution>,
  requestedIdentityId: string | undefined,
): { readonly connector: string; readonly identity: IdentityContribution } {
  const all = [...declared.values()];
  const identity =
    requestedIdentityId === undefined ? (all.length === 1 ? all[0] : undefined) : declared.get(requestedIdentityId);
  if (!identity) {
    const message =
      requestedIdentityId === undefined
        ? 'plugin-authored messages require exactly one declared identity'
        : `identity ${requestedIdentityId} is not declared`;
    throw new MessagingError('VALIDATION', message);
  }
  return { connector: identity.id, identity };
}

function identities(manifest: PluginManifest): ReadonlyMap<string, IdentityContribution> {
  return new Map(
    (manifest.contributions ?? [])
      .filter((contribution): contribution is IdentityContribution => contribution.type === 'identity')
      .map((identity) => [identity.id, identity]),
  );
}

export function pluginMessageSourceOf(
  manifest: PluginManifest,
  origin: MessageDraft['payload']['provenance']['origin'],
  input: PluginMessageSourceInput,
): PluginMessageSourceResult {
  const sender = senderOf(input.sender);
  const requestedIdentityId = input.identity === undefined ? undefined : boundedString(input.identity, 'identity', 200);
  const url = sourceUrlOf(input.url);
  const meta = sourceMetaOf(input.meta);
  const declared = identities(manifest);
  const selected =
    origin?.kind === 'external'
      ? externalPluginIdentity(manifest, declared, origin, requestedIdentityId)
      : authoredIdentity(declared, requestedIdentityId);
  const sourceMeta = {
    ...(meta ?? {}),
    ...(origin?.kind === 'external' && origin.sourceAddress !== undefined
      ? { externalChatId: origin.sourceAddress.chatId }
      : {}),
  };
  return {
    source: {
      connector: selected.connector,
      label: selected.identity.displayName,
      icon: selected.identity.icon ?? 'message',
      ...(url === undefined ? {} : { url }),
      ...(Object.keys(sourceMeta).length === 0 ? {} : { meta: sourceMeta }),
      ...(sender === undefined ? {} : { sender }),
    },
    ...(sender === undefined ? {} : { sender }),
  };
}
