/**
 * Post-commit notification for a managed wake that is already durable.
 *
 * By the time this runs, the Message and its Queue row are committed. Everything here is therefore
 * best-effort by construction — RFC §5.2: Queue commit is the durable boundary, and nothing after
 * it may reverse the verdict. If a failure escaped, the producer would be handed an error, release
 * its content claim and record "nothing was written" about work that is committed and about to run.
 *
 * The two effects are independent on purpose, and that is the part worth being careful about. The
 * broadcast only refreshes a UI panel; the drain is what actually gets the admitted row picked up.
 * Sequencing them in one try block made a failed broadcast skip the drain entirely, leaving a
 * durable wake that nothing asks anyone to look at. They are now separately guarded, the drain runs
 * whatever the broadcast did, and the drain's promise is awaited so an async rejection cannot
 * escape as an unhandled rejection instead of a log line.
 */
export interface ManagedWakeAdmittedNotifierDeps {
  readonly broadcastQueueUpdate?: (threadId: string, userId: string) => Promise<void> | void;
  readonly requestDrain?: (threadId: string) => Promise<unknown> | unknown;
  readonly log: { warn: (context: Record<string, unknown>, message: string) => void };
}

async function bestEffort(
  run: () => Promise<unknown> | unknown,
  log: ManagedWakeAdmittedNotifierDeps['log'],
  context: Record<string, unknown>,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log.warn({ ...context, error }, message);
  }
}

export function createManagedWakeAdmittedNotifier(
  deps: ManagedWakeAdmittedNotifierDeps,
): (threadId: string, userId: string) => Promise<void> {
  return async (threadId, userId) => {
    if (deps.broadcastQueueUpdate) {
      await bestEffort(
        () => deps.broadcastQueueUpdate?.(threadId, userId),
        deps.log,
        { threadId, userId },
        'managed wake admitted durably; Queue panel broadcast failed and is not retried here',
      );
    }
    // Unconditional: a wake nobody drains is a wake nobody receives, and the broadcast above has
    // no bearing on whether the committed row deserves to run.
    if (deps.requestDrain) {
      await bestEffort(
        () => deps.requestDrain?.(threadId),
        deps.log,
        { threadId, userId },
        'managed wake admitted durably; drain signal failed and is not retried here',
      );
    }
  };
}
