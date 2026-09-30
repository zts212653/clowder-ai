import { type CloudConversationReturnCursor, isCloudConversationListResult } from '@clowder-ai/plugin-contract';
import type {
  CloudConversationHostLease,
  CloudConversationHostRegistry,
  CloudConversationProvider,
} from '../../../../plugin/declared/cloud-conversation-host-registry.js';
import type {
  CloudAssistantReturnIngestInput,
  CloudAssistantReturnIngestOutcome,
} from '../cloud-assistant-return-ingest.js';
import { readAckResult } from './conversation-host-results.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** The #1531 cap: failures back off from twice the interval, doubling up to one round per 60s. */
const MAX_BACKOFF_MS = 60_000;

export interface ReturnPollScheduler {
  /** Runs `run` once after `delayMs`; the handle cancels it. */
  schedule(run: () => void, delayMs: number): { cancel(): void };
}

const timerScheduler: ReturnPollScheduler = {
  schedule(run, delayMs) {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

interface ReturnPollerLogger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
}

interface AssistantReturnIngestPort {
  ingest(input: CloudAssistantReturnIngestInput): Promise<CloudAssistantReturnIngestOutcome>;
}

/** One lease's polling. A new lease starts a new generation; nothing carries over. */
interface Generation {
  readonly lease: CloudConversationHostLease;
  pending: { cancel(): void } | undefined;
  failures: number;
  resumeAfter: CloudConversationReturnCursor | undefined;
  ended: boolean;
}

class ReturnPollRoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReturnPollRoundError';
  }
}

/**
 * F202 W2-3 h3b — pulls assistant returns from whichever enabled package hosts the provider, and
 * only while one does (frozen h3「回复轮询跟着已启用的包走」).
 *
 * Nothing happens before `start()`. After it, the poller follows the registry: with no lease it
 * keeps no timer and logs nothing. Each lease is a generation with its own backoff and cursor.
 * Rounds are chained, so a generation never has two in flight, and none is scheduled after its
 * lease ends; a late result from an ended generation touches nothing of the next one.
 *
 * A round is list → Host ingest + return grant → ack, pinned to one lease. The ack is sent only if
 * that lease is still current: otherwise the next generation lists the same return again, the
 * ingest answers duplicate (it is idempotent by source), and that generation acks it. Which
 * returns reach a thread stays the Host's decision through the grant, never the package's.
 */
export class PluginConversationReturnPoller {
  #generation: Generation | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #intervalMs: number;
  readonly #scheduler: ReturnPollScheduler;

  constructor(
    private readonly deps: {
      readonly registry: Pick<CloudConversationHostRegistry, 'current' | 'isCurrent' | 'subscribe'>;
      readonly provider: CloudConversationProvider;
      readonly ingestService: AssistantReturnIngestPort;
      readonly logger: ReturnPollerLogger;
      readonly grantPersistence: 'durable' | 'ephemeral';
      readonly pollIntervalMs?: number;
      readonly scheduler?: ReturnPollScheduler;
    },
  ) {
    this.#intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(this.#intervalMs) || this.#intervalMs < 50) {
      throw new Error('cloud conversation return poll interval must be an integer of at least 50ms');
    }
    this.#scheduler = deps.scheduler ?? timerScheduler;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.registry.subscribe(() => this.#follow());
    this.#follow();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#end();
  }

  #follow(): void {
    const lease = this.deps.registry.current(this.deps.provider);
    if (lease === this.#generation?.lease) return;
    this.#end();
    if (!lease) return;
    const generation: Generation = { lease, pending: undefined, failures: 0, resumeAfter: undefined, ended: false };
    this.#generation = generation;
    this.#schedule(generation, 0);
  }

  #end(): void {
    const generation = this.#generation;
    if (!generation) return;
    generation.ended = true;
    generation.pending?.cancel();
    generation.pending = undefined;
    this.#generation = undefined;
  }

  #schedule(generation: Generation, delayMs: number): void {
    generation.pending = this.#scheduler.schedule(() => void this.#drain(generation), delayMs);
  }

  async #drain(generation: Generation): Promise<void> {
    generation.pending = undefined;
    if (generation.ended) return;
    let failure: { readonly error: unknown } | undefined;
    try {
      await this.#round(generation);
    } catch (error) {
      failure = { error };
    }
    if (generation.ended) return;
    this.#schedule(generation, failure ? this.#failed(generation, failure.error) : this.#answered(generation));
  }

  async #round(generation: Generation): Promise<void> {
    const { lease } = generation;
    const { list, ack } = lease.contribution.assistantReturns;
    const listed = await call(lease, list.method, generation.resumeAfter ? { after: generation.resumeAfter } : {});
    if (!isCloudConversationListResult(listed)) {
      throw new ReturnPollRoundError(`${lease.pluginId} answered list outside the contract`);
    }
    const item = listed.returns[0];
    if (!item) {
      generation.resumeAfter = undefined;
      return;
    }
    const cursor: CloudConversationReturnCursor = {
      conversationId: item.conversationId,
      sourceMessageId: item.sourceMessageId,
      assistantMessageId: item.assistantMessageId,
    };
    const outcome = await this.deps.ingestService.ingest({
      provider: this.deps.provider,
      sourceMessageId: item.sourceMessageId,
      content: item.content,
    });
    if (outcome.status === 'retry') return;
    if (
      outcome.status === 'rejected' &&
      outcome.reason === 'grant_not_found' &&
      this.deps.grantPersistence === 'ephemeral'
    ) {
      // A grant held only in memory is gone after a restart; step past this return, keep it unacked.
      generation.resumeAfter = cursor;
      return;
    }
    if (outcome.status === 'rejected') {
      this.deps.logger.warn(
        { ...cursor, pluginId: lease.pluginId, reason: outcome.reason },
        '[F202] rejected a cloud conversation return outside the server-authorized source boundary',
      );
    }
    if (!this.deps.registry.isCurrent(lease)) return;
    const acked = readAckResult(await call(lease, ack.method, cursor));
    if (!acked) throw new ReturnPollRoundError(`${lease.pluginId} answered ack outside the contract`);
    if (acked.status === 'failed' && acked.errorCode !== 'ASSISTANT_RETURN_NOT_FOUND') {
      throw new ReturnPollRoundError(`${lease.pluginId} did not acknowledge the return: ${acked.errorCode}`);
    }
    generation.resumeAfter = undefined;
  }

  /** Doubles the wait from twice the interval up to the cap; only the first failure is logged. */
  #failed(generation: Generation, error: unknown): number {
    generation.failures += 1;
    if (generation.failures === 1) {
      this.deps.logger.warn(
        { pluginId: generation.lease.pluginId, generation: generation.lease.generation, ...errorDetail(error) },
        `[F202] cloud conversation return polling failed; it backs off exponentially, up to one round per ${MAX_BACKOFF_MS / 1_000}s, until the plugin answers`,
      );
    }
    return Math.min(MAX_BACKOFF_MS, this.#intervalMs * 2 ** generation.failures);
  }

  /** Back to the normal cadence, with one line if it had been failing. */
  #answered(generation: Generation): number {
    if (generation.failures > 0) {
      generation.failures = 0;
      this.deps.logger.info(
        { pluginId: generation.lease.pluginId, generation: generation.lease.generation },
        '[F202] cloud conversation return polling resumed',
      );
    }
    return this.#intervalMs;
  }
}

async function call(lease: CloudConversationHostLease, method: string, params: unknown): Promise<unknown> {
  const outcome = await lease.attempt(method, params);
  if (outcome.status === 'failed') {
    throw new ReturnPollRoundError(`${lease.pluginId} ${method} failed`, { cause: outcome.error });
  }
  return outcome.value;
}

function describe(value: unknown): object | string {
  return value instanceof Error ? { name: value.name, message: value.message } : String(value).slice(0, 200);
}

/** The failure, and what the plugin threw underneath it, for the one state-change line. */
function errorDetail(error: unknown): object {
  const cause = error instanceof Error ? error.cause : undefined;
  return { error: describe(error), ...(cause === undefined ? {} : { cause: describe(cause) }) };
}
