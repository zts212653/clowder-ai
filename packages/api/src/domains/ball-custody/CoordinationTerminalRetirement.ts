import type { IMessageStore, MessageScanCursor } from '../cats/services/stores/ports/MessageStore.js';
import type { A2ADispatchDispositionService } from './A2ADispatchDispositionService.js';

type RetirementService = Pick<A2ADispatchDispositionService, 'completeFromCoordinationTerminal'>;
type RetirementMessages = Pick<IMessageStore, 'getById' | 'scanCoordinationTerminalMessageIds'>;

/** Only the source author's committed consumption can close the reverse handoff. */
export async function retireConsumedCoordinationTerminal(
  messageId: string,
  messageStore: Pick<IMessageStore, 'getById'>,
  service: RetirementService | undefined,
): Promise<'skipped' | 'applied' | 'replayed'> {
  const message = await messageStore.getById(messageId);
  if (message?.extra?.coordination?.phase !== 'terminal') return 'skipped';
  const sourceMessageId = message.extra.causal?.triggerMessageId;
  if (!sourceMessageId) return 'skipped';
  const source = await messageStore.getById(sourceMessageId);
  if (
    source?.extra?.coordination?.phase !== 'active' ||
    !source.catId ||
    !message.queueCustody?.handledByCatIds.includes(source.catId)
  )
    return 'skipped';
  if (!service) throw new Error('a2a_dispatch_disposition_service_unavailable');
  return (await service.completeFromCoordinationTerminal(messageId)).outcome;
}

/**
 * Rebuild retirement work from existing consumed source records after a crash or
 * failed side effect. The cursor and timer only bound reads; neither owns work.
 * No provider invocation, Queue insertion or message-state mutation occurs here.
 */
export class CoordinationTerminalRetirement {
  private cursor: MessageScanCursor | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<{ inspected: number; applied: number; failed: number }> | undefined;

  constructor(
    private readonly deps: {
      messageStore: RetirementMessages;
      service: RetirementService;
      log: { warn(obj: unknown, message: string): void; info(obj: unknown, message: string): void };
    },
  ) {}

  runPage(): Promise<{ inspected: number; applied: number; failed: number }> {
    if (this.running) return this.running;
    const run = this.scanPage();
    this.running = run;
    const release = () => {
      if (this.running === run) this.running = undefined;
    };
    void run.then(release, release);
    return run;
  }

  private async scanPage(): Promise<{ inspected: number; applied: number; failed: number }> {
    const scan = this.deps.messageStore.scanCoordinationTerminalMessageIds;
    if (!scan) return { inspected: 0, applied: 0, failed: 0 };
    const page = await scan.call(this.deps.messageStore, this.cursor);
    let applied = 0;
    let failed = 0;
    for (const messageId of page.messageIds) {
      try {
        if (
          (await retireConsumedCoordinationTerminal(messageId, this.deps.messageStore, this.deps.service)) === 'applied'
        ) {
          applied += 1;
        }
      } catch (err) {
        failed += 1;
        this.deps.log.warn({ err, messageId }, '[coordination-retirement] consumed source retirement deferred');
      }
    }
    // A failed source is retried on the next pass, without starving later pages.
    this.cursor = page.nextCursor;
    const result = { inspected: page.messageIds.length, applied, failed };
    if (applied > 0 || failed > 0) this.deps.log.info(result, '[coordination-retirement] recovery page');
    return result;
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      void this.runPage().catch((err) => {
        this.deps.log.warn({ err }, '[coordination-retirement] message page unavailable; cursor retained');
      });
    };
    this.timer = setInterval(run, 30_000);
    this.timer.unref?.();
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }
}
