import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { HostAppendMessageReceipt, IConversationHostAdapter } from '../conversation-host-adapter.js';
import {
  PersonalChromeHostAdapter,
  type PersonalChromeHostAdapterOptions,
  PersonalChromeHostError,
} from './personal-chrome-host-transport.js';

export type { PersonalChromeHostAdapterOptions } from './personal-chrome-host-transport.js';
export { PersonalChromeHostAdapter, PersonalChromeHostError } from './personal-chrome-host-transport.js';

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
  return {
    socketPath: record.socketPath,
    pairingSecret: record.pairingSecret,
    helperArtifactRevision: record.artifactDigest,
  };
}

export function createPersonalChromeHostAdapterFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  logger: PersonalChromeRuntimeLogger,
): IConversationHostAdapter | null {
  const socketPath = env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
  const pairingSecret = env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
  const helperArtifactRevision = env.CAT_CAFE_PERSONAL_CHROME_HELPER_ARTIFACT_REVISION;
  if (!socketPath && !pairingSecret && !helperArtifactRevision) return null;
  if (!socketPath || !pairingSecret || !helperArtifactRevision) {
    logger.warn(
      {
        hasSocketPath: Boolean(socketPath),
        hasPairingSecret: Boolean(pairingSecret),
        hasHelperArtifactRevision: Boolean(helperArtifactRevision),
      },
      'F247 personal Chrome Host Adapter configuration incomplete; background append disabled',
    );
    return null;
  }
  try {
    const adapter = new PersonalChromeHostAdapter({ socketPath, pairingSecret, helperArtifactRevision });
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
    const helperArtifactRevision = this.options.env.CAT_CAFE_PERSONAL_CHROME_HELPER_ARTIFACT_REVISION;
    if (socketPath || pairingSecret || helperArtifactRevision) {
      if (!socketPath || !pairingSecret || !helperArtifactRevision) {
        throw new PersonalChromeHostError(
          'INVALID_CONFIGURATION',
          'personal Chrome operator override must provide socket, pairing secret, and helper revision together',
        );
      }
      return { socketPath, pairingSecret, helperArtifactRevision };
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
