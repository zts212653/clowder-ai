import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

import type { HostAppendMessageReceipt, IConversationHostAdapter } from '../conversation-host-adapter.js';
import {
  PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES,
  PERSONAL_CHROME_PROTOCOL_VERSION,
  type PersonalChromeAppendRequest,
  type PersonalChromeAppendResult,
  type PersonalChromeLocalEnvelope,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class PersonalChromeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PersonalChromeHostError';
  }
}

export interface PersonalChromeHostAdapterOptions {
  readonly socketPath: string;
  readonly pairingSecret: string;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
}

interface PersonalChromeRuntimeLogger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
}

interface PersistedPersonalChromePairingRecord {
  readonly schemaVersion: 1;
  readonly extensionId: string;
  readonly socketPath: string;
  readonly ledgerPath: string;
  readonly pairingSecret: string;
  readonly artifactDigest: string;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface RefreshablePersonalChromeHostAdapterOptions {
  readonly pairingRecordPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: PersonalChromeRuntimeLogger;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
}

const PAIRING_RECORD_FIELDS = new Set([
  'schemaVersion',
  'extensionId',
  'socketPath',
  'ledgerPath',
  'pairingSecret',
  'artifactDigest',
  'installedAt',
  'updatedAt',
]);
const MAX_PAIRING_RECORD_BYTES = 16 * 1024;

export function resolvePersonalChromePairingRecordPath(projectRoot: string): string {
  if (!projectRoot || projectRoot.trim() !== projectRoot) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'projectRoot must be a non-empty exact path');
  }
  return resolve(projectRoot, '.cat-cafe', 'plugin-host', 'personal-chrome-host', 'pairing.json');
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parsePersistedPairingRecord(value: unknown): PersistedPersonalChromePairingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !PAIRING_RECORD_FIELDS.has(field))) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record contains an unknown field');
  }
  if (
    Object.keys(record).length !== PAIRING_RECORD_FIELDS.size ||
    record.schemaVersion !== 1 ||
    typeof record.extensionId !== 'string' ||
    !/^[a-p]{32}$/.test(record.extensionId) ||
    typeof record.socketPath !== 'string' ||
    !isAbsolute(record.socketPath) ||
    typeof record.ledgerPath !== 'string' ||
    !isAbsolute(record.ledgerPath) ||
    typeof record.pairingSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(record.pairingSecret) ||
    typeof record.artifactDigest !== 'string' ||
    !/^sha512:[a-f0-9]{128}$/.test(record.artifactDigest) ||
    !isCanonicalIsoTimestamp(record.installedAt) ||
    !isCanonicalIsoTimestamp(record.updatedAt)
  ) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record failed validation');
  }
  return record as unknown as PersistedPersonalChromePairingRecord;
}

async function readPersistedAdapterOptions(pairingRecordPath: string): Promise<PersonalChromeHostAdapterOptions> {
  const metadata = await lstat(pairingRecordPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must be a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must have mode 0600');
  }
  if (metadata.size > MAX_PAIRING_RECORD_BYTES) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record exceeds size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pairingRecordPath, 'utf8'));
  } catch (error) {
    throw new PersonalChromeHostError(
      'INVALID_CONFIGURATION',
      `pairing record is unreadable: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
  const record = parsePersistedPairingRecord(parsed);
  return { socketPath: record.socketPath, pairingSecret: record.pairingSecret };
}

export function createPersonalChromeHostAdapterFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  logger: PersonalChromeRuntimeLogger,
): IConversationHostAdapter | null {
  const socketPath = env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
  const pairingSecret = env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
  if (!socketPath && !pairingSecret) return null;
  if (!socketPath || !pairingSecret) {
    logger.warn(
      { hasSocketPath: Boolean(socketPath), hasPairingSecret: Boolean(pairingSecret) },
      'F247 personal Chrome Host Adapter configuration incomplete; background append disabled',
    );
    return null;
  }
  try {
    const adapter = new PersonalChromeHostAdapter({ socketPath, pairingSecret });
    logger.info({ socketPath }, 'F247 personal Chrome Host Adapter configured for background append');
    return adapter;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
      'F247 personal Chrome Host Adapter configuration rejected',
    );
    return null;
  }
}

export class RefreshablePersonalChromeHostAdapter implements IConversationHostAdapter {
  private readonly requestId: () => string;

  constructor(private readonly options: RefreshablePersonalChromeHostAdapterOptions) {
    if (!isAbsolute(options.pairingRecordPath)) {
      throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairingRecordPath must be absolute');
    }
    this.requestId = options.requestId ?? randomUUID;
  }

  private async resolveSnapshot(): Promise<PersonalChromeHostAdapterOptions> {
    const socketPath = this.options.env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
    const pairingSecret = this.options.env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
    if (socketPath || pairingSecret) {
      if (!socketPath || !pairingSecret) {
        throw new PersonalChromeHostError(
          'INVALID_CONFIGURATION',
          'personal Chrome operator override must provide socket and pairing secret together',
        );
      }
      return { socketPath, pairingSecret };
    }
    try {
      return await readPersistedAdapterOptions(this.options.pairingRecordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new PersonalChromeHostError('HOST_UNAVAILABLE', 'personal Chrome Host Adapter is not installed');
      }
      if (error instanceof PersonalChromeHostError) throw error;
      throw new PersonalChromeHostError(
        'INVALID_CONFIGURATION',
        `personal Chrome pairing state is unavailable: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  async append_message(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<HostAppendMessageReceipt> {
    const snapshot = await this.resolveSnapshot();
    const adapter = new PersonalChromeHostAdapter({
      ...snapshot,
      timeoutMs: this.options.timeoutMs,
      requestId: this.requestId,
    });
    return adapter.append_message(conversationId, text, idempotencyKey);
  }
}

export function createRefreshablePersonalChromeHostAdapter(args: {
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: PersonalChromeRuntimeLogger;
}): IConversationHostAdapter {
  const pairingRecordPath = resolvePersonalChromePairingRecordPath(args.projectRoot);
  args.logger.info(
    { pairingRecordPath, hasOperatorOverride: Boolean(args.env.CAT_CAFE_PERSONAL_CHROME_SOCKET) },
    'F247 personal Chrome Host Adapter resolver configured',
  );
  return new RefreshablePersonalChromeHostAdapter({
    pairingRecordPath,
    env: args.env,
    logger: args.logger,
  });
}

function validateOptions(options: PersonalChromeHostAdapterOptions): void {
  if (!options.socketPath || options.socketPath.trim() !== options.socketPath) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'socketPath must be a non-empty exact path');
  }
  if (options.pairingSecret.length < 32 || options.pairingSecret.length > 512) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairingSecret must contain 32-512 characters');
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10)) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'timeoutMs must be an integer of at least 10');
  }
}

function exchangeLocalFrame(
  options: PersonalChromeHostAdapterOptions,
  envelope: PersonalChromeLocalEnvelope,
): Promise<PersonalChromeAppendResult> {
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
    return Promise.reject(new PersonalChromeHostError('REQUEST_TOO_LARGE', 'local append frame exceeds limit'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let settled = false;
    let input = '';
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new PersonalChromeHostError('HOST_TIMEOUT', 'personal Chrome host timed out')));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(serialized));
    socket.once('error', (error) => {
      finish(() =>
        reject(new PersonalChromeHostError('HOST_UNAVAILABLE', `personal Chrome host unavailable: ${error.message}`)),
      );
    });
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host receipt exceeds limit')));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      try {
        const result = parsePersonalChromeAppendResult(JSON.parse(input.slice(0, newline)));
        finish(() => resolve(result));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', detail)));
      }
    });
    socket.once('end', () => {
      if (!settled) {
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host closed without a receipt')));
      }
    });
  });
}

export class PersonalChromeHostAdapter implements IConversationHostAdapter {
  private readonly requestId: () => string;

  constructor(private readonly options: PersonalChromeHostAdapterOptions) {
    validateOptions(options);
    this.requestId = options.requestId ?? randomUUID;
  }

  async append_message(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<HostAppendMessageReceipt> {
    let request: PersonalChromeAppendRequest;
    try {
      request = parsePersonalChromeAppendRequest({
        v: PERSONAL_CHROME_PROTOCOL_VERSION,
        kind: 'append_message',
        requestId: this.requestId(),
        conversationId,
        text,
        idempotencyKey,
      });
    } catch (error) {
      throw new PersonalChromeHostError('INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    }
    const result = await exchangeLocalFrame(this.options, {
      pairingSecret: this.options.pairingSecret,
      request,
    });
    if (result.requestId !== request.requestId || result.idempotencyKey !== request.idempotencyKey) {
      throw new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host receipt does not match the append request');
    }
    if (result.status === 'failed') {
      throw new PersonalChromeHostError(result.errorCode, `personal Chrome host failed: ${result.errorCode}`);
    }
    if (!result.hostMessageId.trim()) {
      throw new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'hostMessageId must be non-empty');
    }
    return { hostMessageId: result.hostMessageId };
  }
}
