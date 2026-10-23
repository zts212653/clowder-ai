import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';
import type { IPawFeelDispositionEventLog } from './event-log.js';
import type { PawFeelInboxAuditEntry } from './projection/read-model-audit.js';
import type { PawFeelDispositionReadModel } from './read-model.js';

const CURSOR_SECRET_BYTES = 32;
const CURSOR_TOKEN_MAX_BYTES = 100_000;
const CURSOR_CONTRACT = 'f278-inbox-audit-scan:v1';
const CURSOR_SECRET_KEY = 'paw-feel:disposition:inbox-audit-scan-secret';

const signalIdSchema = z.string().trim().min(1).max(1_000);
const scanCursorSchema = z
  .object({
    redisCursor: z.string().regex(/^\d{1,40}$/u),
    pendingSignalIds: z.array(signalIdSchema).max(50),
    completeAfterPending: z.boolean(),
  })
  .strict();
const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    contract: z.literal(CURSOR_CONTRACT),
    startedAt: z.string().datetime({ offset: true }),
    pageLimit: z.number().int().min(1).max(50),
    totalScannedSignals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scanCursor: scanCursorSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const pending = payload.scanCursor.pendingSignalIds;
    if (new Set(pending).size !== pending.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending signal ids must be distinct' });
    }
    if (
      (payload.scanCursor.completeAfterPending && (payload.scanCursor.redisCursor !== '0' || pending.length === 0)) ||
      (!payload.scanCursor.completeAfterPending && payload.scanCursor.redisCursor === '0')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'scan cursor state is impossible' });
    }
  });

type PawFeelInboxAuditCursorPayload = z.infer<typeof cursorPayloadSchema>;

export class PawFeelInboxAuditCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PawFeelInboxAuditCursorError';
  }
}

export class PawFeelInboxAuditCursorSigner {
  constructor(private readonly secret: Buffer = randomBytes(CURSOR_SECRET_BYTES)) {
    if (secret.length !== CURSOR_SECRET_BYTES) throw new Error('invalid inbox audit cursor secret');
  }

  sign(rawPayload: PawFeelInboxAuditCursorPayload): string {
    const payload = cursorPayloadSchema.parse(rawPayload);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    const token = `${encoded}.${signature}`;
    if (Buffer.byteLength(token) > CURSOR_TOKEN_MAX_BYTES) {
      throw new PawFeelInboxAuditCursorError('inbox audit cursor token exceeds the bounded size');
    }
    return token;
  }

  verify(token: string): PawFeelInboxAuditCursorPayload {
    if (!token || Buffer.byteLength(token) > CURSOR_TOKEN_MAX_BYTES) {
      throw new PawFeelInboxAuditCursorError('invalid inbox audit cursor token size');
    }
    const [encoded, supplied, extra] = token.split('.');
    if (
      !encoded ||
      !supplied ||
      extra !== undefined ||
      Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    ) {
      throw new PawFeelInboxAuditCursorError('invalid inbox audit cursor token');
    }
    const expectedSignature = createHmac('sha256', this.secret).update(encoded).digest();
    const suppliedSignature = Buffer.from(supplied, 'base64url');
    if (
      suppliedSignature.toString('base64url') !== supplied ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new PawFeelInboxAuditCursorError('invalid inbox audit cursor signature');
    }
    try {
      return cursorPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      throw new PawFeelInboxAuditCursorError('invalid or version-drifted inbox audit cursor payload');
    }
  }
}

function decodeSecret(encoded: string): Buffer {
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== CURSOR_SECRET_BYTES || secret.toString('base64url') !== encoded) {
    throw new Error('invalid persisted inbox audit cursor secret');
  }
  return secret;
}

export async function loadOrCreatePawFeelInboxAuditCursorSigner(
  redis: RedisClient,
): Promise<PawFeelInboxAuditCursorSigner> {
  const candidate = randomBytes(CURSOR_SECRET_BYTES).toString('base64url');
  await redis.set(CURSOR_SECRET_KEY, candidate, 'NX');
  const persisted = await redis.get(CURSOR_SECRET_KEY);
  if (!persisted) throw new Error('inbox audit cursor secret was not persisted');
  return new PawFeelInboxAuditCursorSigner(decodeSecret(persisted));
}

export type PawFeelInboxAuditScanPage = {
  status: 'partial' | 'complete';
  startedAt: string;
  generatedAt: string;
  pageScannedSignals: number;
  totalScannedSignals: number;
  entries: PawFeelInboxAuditEntry[];
  nextCursor?: string;
};

interface PawFeelInboxAuditScanServiceOptions {
  eventLog: Pick<IPawFeelDispositionEventLog, 'scanSignalIds'>;
  readModel: Pick<PawFeelDispositionReadModel, 'readAuditSignals'>;
  signer: PawFeelInboxAuditCursorSigner;
  now?: () => string;
}

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new PawFeelInboxAuditCursorError('inbox audit scan limit must be between 1 and 50');
  }
  return limit;
}

export class PawFeelInboxAuditScanService {
  private readonly now: () => string;

  constructor(private readonly options: PawFeelInboxAuditScanServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async read(input: { cursor?: string; limit?: number } = {}): Promise<PawFeelInboxAuditScanPage> {
    const requestedLimit = requireLimit(input.limit ?? 50);
    const prior = input.cursor ? this.options.signer.verify(input.cursor) : undefined;
    if (prior && input.limit !== undefined && requestedLimit !== prior.pageLimit) {
      throw new PawFeelInboxAuditCursorError('inbox audit scan cursor limit changed');
    }
    const pageLimit = prior?.pageLimit ?? requestedLimit;
    const generatedAt = this.now();
    if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('inbox audit generatedAt is invalid');
    const startedAt = prior?.startedAt ?? generatedAt;
    const page = await this.options.eventLog.scanSignalIds(prior?.scanCursor, pageLimit);
    if (page.signalIds.length > pageLimit) throw new Error('inbox audit source exceeded its page contract');
    const entries = await this.options.readModel.readAuditSignals(page.signalIds);
    if (
      entries.length !== page.signalIds.length ||
      entries.some((entry, index) => entry.disposition.signalId !== page.signalIds[index])
    ) {
      throw new Error('inbox audit projection reader returned a mismatched page');
    }
    const totalScannedSignals = (prior?.totalScannedSignals ?? 0) + page.signalIds.length;
    if (!Number.isSafeInteger(totalScannedSignals)) throw new Error('inbox audit scan count overflow');
    const base = {
      startedAt,
      generatedAt,
      pageScannedSignals: page.signalIds.length,
      totalScannedSignals,
      entries,
    };
    if (!page.nextCursor) return { status: 'complete', ...base };
    return {
      status: 'partial',
      ...base,
      nextCursor: this.options.signer.sign({
        v: 1,
        contract: CURSOR_CONTRACT,
        startedAt,
        pageLimit,
        totalScannedSignals,
        scanCursor: {
          ...page.nextCursor,
          pendingSignalIds: [...page.nextCursor.pendingSignalIds],
        },
      }),
    };
  }
}
