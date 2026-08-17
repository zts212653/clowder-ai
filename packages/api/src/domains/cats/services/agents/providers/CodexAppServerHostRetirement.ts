import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  codexAppServerHostMigration,
  codexAppServerHostMigrationDuration,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { type HostEntry, type HostRetirementReason, waitForHostLeaseRelease } from './CodexAppServerHostLease.js';

const log = createModuleLogger('codex-app-server-host-pool');

export async function retireCodexSessionHost(input: {
  entry: HostEntry;
  reason: HostRetirementReason;
  sessionId: string;
  signal?: AbortSignal;
  close: (entry: HostEntry) => Promise<void>;
}): Promise<void> {
  const startedAt = Date.now();
  const fields = {
    reason: input.reason,
    sessionIdPrefix: input.sessionId.slice(0, 8),
    ownerSessionIdPrefix: input.entry.lease?.sessionId?.slice(0, 8) ?? null,
  };
  codexAppServerHostMigration.add(1, { reason: input.reason, status: 'retiring' });
  log.info(fields, '[codex-host] retiring source host before native-session migration');
  try {
    await waitForHostLeaseRelease(input.entry, input.signal);
    await input.close(input.entry);
    codexAppServerHostMigration.add(1, { reason: input.reason, status: 'retired' });
    log.info(fields, '[codex-host] source host retired; native-session migration may proceed');
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
    codexAppServerHostMigration.add(1, { reason: input.reason, status: cancelled ? 'cancelled' : 'failed' });
    const message = cancelled
      ? '[codex-host] source host retirement wait cancelled; active lease preserved'
      : '[codex-host] source host retirement failed; migration remains fenced';
    if (cancelled) log.info(fields, message);
    else log.warn({ ...fields, err: error }, message);
    throw error;
  } finally {
    codexAppServerHostMigrationDuration.record((Date.now() - startedAt) / 1000, { reason: input.reason });
  }
}
