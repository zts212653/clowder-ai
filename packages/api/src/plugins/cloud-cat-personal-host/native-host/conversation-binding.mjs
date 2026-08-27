import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { acquireProcessLease } from './native-socket-lease.mjs';

const COLLECTION_FIELDS = new Set(['schemaVersion', 'provider', 'conversations', 'updatedAt']);
const AUTHORIZATION_FIELDS = new Set(['conversationId', 'chatUrl', 'authorizedAt', 'updatedAt']);
const LEGACY_FIELDS = new Set(['schemaVersion', 'provider', 'conversationId', 'chatUrl', 'boundAt', 'updatedAt']);
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,200}$/;
const MAX_COLLECTION_BYTES = 64 * 1024;
const MUTATION_LOCK_ATTEMPTS = 200;
const MUTATION_LOCK_RETRY_BASE_MS = 10;
const MUTATION_LOCK_RETRY_JITTER_MS = 15;
const processLocalMutationTails = new Map();
export const PERSONAL_CHROME_AUTHORIZATION_LIMIT = 32;

export class PersonalChromeConversationAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersonalChromeConversationAuthorizationError';
    this.code = code;
  }
}

export function isPersonalChromeConversationId(value) {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

function requireExactString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty exact string`);
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireExactString(value, field);
  if (!isAbsolute(value)) throw new Error(`${field} must be absolute`);
  return value;
}

function requireIsoTimestamp(value, field) {
  requireExactString(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function latestTimestamp(left, right) {
  return left >= right ? left : right;
}

function requireExactFields(value, fields, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`${label} is missing field: ${field}`);
  }
}

export function conversationIdFromExactChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.search || url.hash) return null;
    return url.pathname.match(/^\/c\/([A-Za-z0-9-]{1,200})\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function validateAuthorization(value, label = 'conversation authorization') {
  requireExactFields(value, AUTHORIZATION_FIELDS, label);
  if (!isPersonalChromeConversationId(value.conversationId)) {
    throw new Error(`${label} conversationId has an invalid format`);
  }
  const urlConversationId = conversationIdFromExactChatGptUrl(value.chatUrl);
  if (!urlConversationId) throw new Error(`${label} chatUrl must be an exact https://chatgpt.com/c/<id> URL`);
  if (urlConversationId !== value.conversationId) throw new Error(`${label} chatUrl must match conversationId`);
  const authorizedAt = requireIsoTimestamp(value.authorizedAt, `${label} authorizedAt`);
  const updatedAt = requireIsoTimestamp(value.updatedAt, `${label} updatedAt`);
  if (updatedAt < authorizedAt) throw new Error(`${label} updatedAt must not predate authorizedAt`);
  return {
    conversationId: value.conversationId,
    chatUrl: value.chatUrl,
    authorizedAt,
    updatedAt,
  };
}

export function validatePersonalChromeConversationAuthorizations(value) {
  requireExactFields(value, COLLECTION_FIELDS, 'conversation authorization collection');
  if (value.schemaVersion !== 2) throw new Error('schemaVersion must equal 2');
  if (value.provider !== 'chatgpt') throw new Error('provider must equal chatgpt');
  if (!Array.isArray(value.conversations)) throw new Error('conversations must be an array');
  if (value.conversations.length > PERSONAL_CHROME_AUTHORIZATION_LIMIT) {
    throw new Error(`conversation authorization limit is ${PERSONAL_CHROME_AUTHORIZATION_LIMIT}`);
  }
  const conversations = value.conversations.map((entry, index) =>
    validateAuthorization(entry, `conversations[${index}]`),
  );
  const seen = new Set();
  for (const entry of conversations) {
    if (seen.has(entry.conversationId)) throw new Error(`duplicate conversationId: ${entry.conversationId}`);
    seen.add(entry.conversationId);
  }
  const updatedAt = requireIsoTimestamp(value.updatedAt, 'collection updatedAt');
  if (conversations.some((entry) => entry.updatedAt > updatedAt)) {
    throw new Error('collection updatedAt must cover every authorization update');
  }
  return { schemaVersion: 2, provider: 'chatgpt', conversations, updatedAt };
}

function validateLegacyBinding(value) {
  requireExactFields(value, LEGACY_FIELDS, 'legacy conversation binding');
  if (value.schemaVersion !== 1) throw new Error('legacy schemaVersion must equal 1');
  if (value.provider !== 'chatgpt') throw new Error('legacy provider must equal chatgpt');
  const conversationId = value.conversationId;
  if (!isPersonalChromeConversationId(conversationId)) {
    throw new Error('legacy conversationId has an invalid format');
  }
  if (conversationIdFromExactChatGptUrl(value.chatUrl) !== conversationId) {
    throw new Error('legacy chatUrl must match conversationId');
  }
  const authorizedAt = requireIsoTimestamp(value.boundAt, 'legacy boundAt');
  const updatedAt = requireIsoTimestamp(value.updatedAt, 'legacy updatedAt');
  if (updatedAt < authorizedAt) throw new Error('legacy updatedAt must not predate boundAt');
  return {
    schemaVersion: 2,
    provider: 'chatgpt',
    conversations: [{ conversationId, chatUrl: value.chatUrl, authorizedAt, updatedAt }],
    updatedAt,
  };
}

async function readPersistedAuthorizations(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PersonalChromeConversationAuthorizationError(
        'NEEDS_AUTHORIZATION',
        'authorize at least one ChatGPT conversation explicitly',
      );
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('conversation authorization collection must be a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error('conversation authorization collection must have mode 0600');
  }
  if (metadata.size > MAX_COLLECTION_BYTES) throw new Error('conversation authorization collection exceeds size limit');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `conversation authorization collection is unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (parsed?.schemaVersion === 1) return { collection: validateLegacyBinding(parsed), legacy: true };
  return { collection: validatePersonalChromeConversationAuthorizations(parsed), legacy: false };
}

export async function writePersonalChromeConversationAuthorizationsAtomic(path, value, options = {}) {
  requireAbsolutePath(path, 'conversationAuthorizationPath');
  const collection = validatePersonalChromeConversationAuthorizations(value);
  const payload = `${JSON.stringify(collection, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_COLLECTION_BYTES) {
    throw new Error('conversation authorization collection exceeds size limit');
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(parent, 0o700);
  const temporaryPath = resolve(parent, `.${randomUUID()}.conversation-authorization.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await (options.renameFile ?? rename)(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return collection;
}

async function serializeProcessLocalMutation(path, operation) {
  const predecessor = processLocalMutationTails.get(path);
  let release;
  const completion = new Promise((resolveCompletion) => {
    release = resolveCompletion;
  });
  processLocalMutationTails.set(path, completion);
  try {
    await predecessor;
    return await operation();
  } finally {
    release();
    if (processLocalMutationTails.get(path) === completion) processLocalMutationTails.delete(path);
  }
}

async function acquireAuthorizationMutationLease(path) {
  for (let attempt = 0; attempt < MUTATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await acquireProcessLease(path, { label: 'conversation authorization mutation' });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already has a live owner')) throw error;
      if (attempt === MUTATION_LOCK_ATTEMPTS - 1) {
        throw new PersonalChromeConversationAuthorizationError(
          'AUTHORIZATION_BUSY',
          'conversation authorization mutation remained busy',
        );
      }
      // Jittered delay reduces thundering-herd contention between processes.
      // Same-process writers never enter this loop concurrently: they wait on
      // the per-path queue without consuming the cross-process budget.
      const delay = MUTATION_LOCK_RETRY_BASE_MS + Math.floor(Math.random() * MUTATION_LOCK_RETRY_JITTER_MS);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw new Error('conversation authorization mutation lease attempts were not executed');
}

async function withAuthorizationMutation(path, operation) {
  const normalizedPath = resolve(requireAbsolutePath(path, 'conversationAuthorizationPath'));
  return serializeProcessLocalMutation(normalizedPath, async () => {
    const parent = dirname(normalizedPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(parent, 0o700);
    const lease = await acquireAuthorizationMutationLease(normalizedPath);
    try {
      return await operation(normalizedPath);
    } finally {
      await lease?.release();
    }
  });
}

export async function readPersonalChromeConversationAuthorizations(path, { migrateLegacy = true } = {}) {
  requireAbsolutePath(path, 'conversationAuthorizationPath');
  const snapshot = await readPersistedAuthorizations(path);
  if (!snapshot.legacy) return snapshot.collection;
  if (!migrateLegacy) return snapshot.collection;
  return withAuthorizationMutation(path, async (normalizedPath) => {
    const current = await readPersistedAuthorizations(normalizedPath);
    if (current.legacy) {
      await writePersonalChromeConversationAuthorizationsAtomic(normalizedPath, current.collection);
    }
    return current.collection;
  });
}

export async function authorizePersonalChromeConversation(path, value) {
  const authorization = validateAuthorization(value);
  return withAuthorizationMutation(path, async (normalizedPath) => {
    let snapshot;
    try {
      snapshot = await readPersistedAuthorizations(normalizedPath);
    } catch (error) {
      if (!(error instanceof PersonalChromeConversationAuthorizationError) || error.code !== 'NEEDS_AUTHORIZATION') {
        throw error;
      }
      snapshot = {
        collection: { schemaVersion: 2, provider: 'chatgpt', conversations: [], updatedAt: authorization.updatedAt },
        legacy: false,
      };
    }
    const existing = snapshot.collection.conversations.find(
      (entry) => entry.conversationId === authorization.conversationId,
    );
    if (existing) {
      if (snapshot.legacy) {
        await writePersonalChromeConversationAuthorizationsAtomic(normalizedPath, snapshot.collection);
      }
      return { collection: snapshot.collection, authorization: existing, added: false };
    }
    if (snapshot.collection.conversations.length >= PERSONAL_CHROME_AUTHORIZATION_LIMIT) {
      throw new PersonalChromeConversationAuthorizationError(
        'AUTHORIZATION_LIMIT_REACHED',
        `at most ${PERSONAL_CHROME_AUTHORIZATION_LIMIT} conversations may be authorized`,
      );
    }
    const collection = {
      ...snapshot.collection,
      conversations: [...snapshot.collection.conversations, authorization],
      updatedAt: latestTimestamp(snapshot.collection.updatedAt, authorization.updatedAt),
    };
    await writePersonalChromeConversationAuthorizationsAtomic(normalizedPath, collection);
    return { collection, authorization, added: true };
  });
}

export async function revokePersonalChromeConversation(path, conversationId, timestamp) {
  if (!isPersonalChromeConversationId(conversationId)) {
    throw new Error('conversationId has an invalid format');
  }
  const updatedAt = requireIsoTimestamp(timestamp, 'revocation timestamp');
  return withAuthorizationMutation(path, async (normalizedPath) => {
    const snapshot = await readPersistedAuthorizations(normalizedPath);
    const conversations = snapshot.collection.conversations.filter((entry) => entry.conversationId !== conversationId);
    if (conversations.length === snapshot.collection.conversations.length) {
      if (snapshot.legacy) {
        await writePersonalChromeConversationAuthorizationsAtomic(normalizedPath, snapshot.collection);
      }
      return { collection: snapshot.collection, revoked: false };
    }
    const collection = {
      ...snapshot.collection,
      conversations,
      updatedAt: latestTimestamp(snapshot.collection.updatedAt, updatedAt),
    };
    await writePersonalChromeConversationAuthorizationsAtomic(normalizedPath, collection);
    return { collection, revoked: true };
  });
}

export async function removePersonalChromeConversationAuthorizations(path) {
  return withAuthorizationMutation(path, async (normalizedPath) => {
    await unlink(normalizedPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  });
}
