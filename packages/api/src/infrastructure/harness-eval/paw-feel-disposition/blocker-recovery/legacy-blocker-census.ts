import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';
import { projectPawFeelDisposition } from '../projector.js';
import type { PawFeelDispositionService } from '../service.js';
import { digestLegacyPawFeelBlockerEvent } from './blocker-reopen-identity.js';
import {
  createLegacyPawFeelBlockerManifest,
  type LegacyPawFeelBlockerManifest,
  type LegacyPawFeelBlockerManifestEntry,
} from './legacy-blocker-recovery.js';

const CURSOR_SECRET_BYTES = 32;
const CURSOR_TOKEN_MAX_BYTES = 100_000;
const CURSOR_ELIGIBLE_MAX = 51;
const SIGNAL_PAGE_LIMIT = 50;
const CURSOR_CONTRACT = 'f313-legacy-blocker-census:v1';
const CURSOR_SECRET_KEY = 'paw-feel:disposition:legacy-blocker-census-secret';

const signalIdSchema = z.string().trim().min(1).max(1_000);
const scanCursorSchema = z
  .object({
    redisCursor: z.string().regex(/^\d{1,40}$/u),
    pendingSignalIds: z.array(signalIdSchema).max(50),
    completeAfterPending: z.boolean(),
  })
  .strict();
const manifestEntrySchema = z
  .object({
    signalId: signalIdSchema,
    blockingSequence: z.number().int().positive(),
    blockerEventDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    contract: z.literal(CURSOR_CONTRACT),
    frozenAt: z.string().datetime({ offset: true }),
    manifestLimit: z.number().int().min(1).max(50),
    totalScannedSignals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scanCursor: scanCursorSchema,
    eligibleEntries: z.array(manifestEntrySchema).max(CURSOR_ELIGIBLE_MAX),
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
    const ids = payload.eligibleEntries.map((entry) => entry.signalId);
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => id !== sorted[index]) ||
      ids.length > payload.manifestLimit + 1
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'eligible accumulator is non-canonical' });
    }
  });

type LegacyPawFeelBlockerCensusCursorPayload = z.infer<typeof cursorPayloadSchema>;

export class LegacyPawFeelBlockerCensusCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyPawFeelBlockerCensusCursorError';
  }
}

export class LegacyPawFeelBlockerCensusCursorSigner {
  constructor(private readonly secret: Buffer = randomBytes(CURSOR_SECRET_BYTES)) {
    if (secret.length !== CURSOR_SECRET_BYTES) throw new Error('invalid legacy blocker census cursor secret');
  }

  sign(rawPayload: LegacyPawFeelBlockerCensusCursorPayload): string {
    const payload = cursorPayloadSchema.parse(rawPayload);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    const token = `${encoded}.${signature}`;
    if (Buffer.byteLength(token) > CURSOR_TOKEN_MAX_BYTES) {
      throw new LegacyPawFeelBlockerCensusCursorError('legacy census cursor token exceeds the bounded size');
    }
    return token;
  }

  verify(token: string): LegacyPawFeelBlockerCensusCursorPayload {
    if (!token || Buffer.byteLength(token) > CURSOR_TOKEN_MAX_BYTES) {
      throw new LegacyPawFeelBlockerCensusCursorError('invalid legacy census cursor token size');
    }
    const [encoded, supplied, extra] = token.split('.');
    if (
      !encoded ||
      !supplied ||
      extra !== undefined ||
      Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    ) {
      throw new LegacyPawFeelBlockerCensusCursorError('invalid legacy census cursor token');
    }
    const expectedSignature = createHmac('sha256', this.secret).update(encoded).digest();
    const suppliedSignature = Buffer.from(supplied, 'base64url');
    if (
      suppliedSignature.toString('base64url') !== supplied ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new LegacyPawFeelBlockerCensusCursorError('invalid legacy census cursor signature');
    }
    try {
      return cursorPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      throw new LegacyPawFeelBlockerCensusCursorError('invalid or version-drifted legacy census cursor payload');
    }
  }
}

function decodeSecret(encoded: string): Buffer {
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== CURSOR_SECRET_BYTES || secret.toString('base64url') !== encoded) {
    throw new Error('invalid persisted legacy blocker census secret');
  }
  return secret;
}

export async function loadOrCreateLegacyPawFeelBlockerCensusCursorSigner(
  redis: RedisClient,
): Promise<LegacyPawFeelBlockerCensusCursorSigner> {
  const candidate = randomBytes(CURSOR_SECRET_BYTES).toString('base64url');
  await redis.set(CURSOR_SECRET_KEY, candidate, 'NX');
  const persisted = await redis.get(CURSOR_SECRET_KEY);
  if (!persisted) throw new Error('legacy blocker census cursor secret was not persisted');
  return new LegacyPawFeelBlockerCensusCursorSigner(decodeSecret(persisted));
}

export type LegacyPawFeelBlockerCensusPage =
  | {
      status: 'partial';
      pageScannedSignals: number;
      totalScannedSignals: number;
      nextCursor: string;
    }
  | {
      status: 'complete';
      pageScannedSignals: number;
      totalScannedSignals: number;
      manifest: LegacyPawFeelBlockerManifest;
    };

interface LegacyPawFeelBlockerCensusServiceOptions {
  service: Pick<PawFeelDispositionService, 'scanSignalIds' | 'readSignalEvents'>;
  signer: LegacyPawFeelBlockerCensusCursorSigner;
  now?: () => string;
}

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new LegacyPawFeelBlockerCensusCursorError('legacy blocker census limit must be between 1 and 50');
  }
  return limit;
}

function eligibleEntry(
  signalId: string,
  events: Awaited<ReturnType<PawFeelDispositionService['readSignalEvents']>>,
): LegacyPawFeelBlockerManifestEntry | null {
  if (events.length === 0) return null;
  const projection = projectPawFeelDisposition(events);
  if (projection.state !== 'blocked' || projection.blocker?.resumeCondition) return null;
  const blockingEvent = events[projection.sequence - 1];
  if (!blockingEvent || blockingEvent.type !== 'blocked' || blockingEvent.resumeCondition) return null;
  return {
    signalId,
    blockingSequence: projection.sequence,
    blockerEventDigest: digestLegacyPawFeelBlockerEvent(blockingEvent),
  };
}

function resolveCensusState(input: {
  cursor?: string;
  limit?: number;
  signer: LegacyPawFeelBlockerCensusCursorSigner;
  now: () => string;
}) {
  const requestedLimit = requireLimit(input.limit ?? 50);
  const prior = input.cursor ? input.signer.verify(input.cursor) : undefined;
  if (prior && input.limit !== undefined && requestedLimit !== prior.manifestLimit) {
    throw new LegacyPawFeelBlockerCensusCursorError('legacy census cursor limit changed');
  }
  const frozenAt = prior?.frozenAt ?? input.now();
  if (!Number.isFinite(Date.parse(frozenAt))) {
    throw new LegacyPawFeelBlockerCensusCursorError('legacy census frozenAt is invalid');
  }
  return { prior, frozenAt, manifestLimit: prior?.manifestLimit ?? requestedLimit };
}

async function collectEligibleEntries(input: {
  service: Pick<PawFeelDispositionService, 'readSignalEvents'>;
  signalIds: readonly string[];
  priorEntries: readonly LegacyPawFeelBlockerManifestEntry[];
  manifestLimit: number;
}): Promise<LegacyPawFeelBlockerManifestEntry[]> {
  const eligible = new Map(input.priorEntries.map((entry) => [entry.signalId, entry]));
  for (const signalId of input.signalIds) {
    const entry = eligibleEntry(signalId, await input.service.readSignalEvents(signalId));
    if (entry) eligible.set(signalId, entry);
    else eligible.delete(signalId);
  }
  return [...eligible.values()]
    .sort((left, right) => left.signalId.localeCompare(right.signalId))
    .slice(0, input.manifestLimit + 1);
}

export class LegacyPawFeelBlockerCensusService {
  private readonly now: () => string;

  constructor(private readonly options: LegacyPawFeelBlockerCensusServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async read(input: { cursor?: string; limit?: number } = {}): Promise<LegacyPawFeelBlockerCensusPage> {
    const { prior, frozenAt, manifestLimit } = resolveCensusState({
      ...input,
      signer: this.options.signer,
      now: this.now,
    });
    const page = await this.options.service.scanSignalIds(prior?.scanCursor, SIGNAL_PAGE_LIMIT);
    if (page.signalIds.length > SIGNAL_PAGE_LIMIT) throw new Error('legacy census source exceeded its page contract');
    const eligibleEntries = await collectEligibleEntries({
      service: this.options.service,
      signalIds: page.signalIds,
      priorEntries: prior?.eligibleEntries ?? [],
      manifestLimit,
    });
    const totalScannedSignals = (prior?.totalScannedSignals ?? 0) + page.signalIds.length;
    if (!Number.isSafeInteger(totalScannedSignals)) throw new Error('legacy census scan count overflow');

    if (page.nextCursor) {
      return {
        status: 'partial',
        pageScannedSignals: page.signalIds.length,
        totalScannedSignals,
        nextCursor: this.options.signer.sign({
          v: 1,
          contract: CURSOR_CONTRACT,
          frozenAt,
          manifestLimit,
          totalScannedSignals,
          scanCursor: {
            ...page.nextCursor,
            pendingSignalIds: [...page.nextCursor.pendingSignalIds],
          },
          eligibleEntries,
        }),
      };
    }
    return {
      status: 'complete',
      pageScannedSignals: page.signalIds.length,
      totalScannedSignals,
      manifest: createLegacyPawFeelBlockerManifest({
        frozenAt,
        entries: eligibleEntries.slice(0, manifestLimit),
        truncated: eligibleEntries.length > manifestLimit,
      }),
    };
  }
}

export const LegacyPawFeelBlockerCensusCursorSecretKey = CURSOR_SECRET_KEY;
