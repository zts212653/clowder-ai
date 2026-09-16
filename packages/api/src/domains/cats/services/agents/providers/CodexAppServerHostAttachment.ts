import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';
import { wrapAttachedHostConnection } from './CodexAppServerHostConnections.js';
import { type HostEntry, resolveHostAttachmentEntry } from './CodexAppServerHostLease.js';
import { retireCodexSessionHost } from './CodexAppServerHostRetirement.js';
import { type PreparedCodexHostLaunch, prepareCodexHostLaunch } from './CodexUnixWebSocketSession.js';

interface HostAttachmentContext {
  entries: ReadonlySet<HostEntry>;
  sessionOwners: Map<string, HostEntry>;
  ensureOpen(): void;
  reapDeadEntries(): Promise<void>;
  spawnEntry(prepared: PreparedCodexHostLaunch): Promise<HostEntry>;
  connectEntry(entry: HostEntry): Promise<AgentCarrierSession>;
  closeEntry(entry: HostEntry, reason: 'connect_failed' | 'dead' | 'session_migration'): Promise<void>;
  releaseEntry(entry: HostEntry): Promise<void>;
  clearIdleTimer(entry: HostEntry): void;
  recordWarmReuse(): void;
}

export async function createCodexAppServerHostAttachment(
  options: AgentCarrierSessionOptions & { sessionId: string },
  context: HostAttachmentContext,
): Promise<AgentCarrierSession> {
  context.ensureOpen();
  const prepared = prepareCodexHostLaunch(options);
  await context.reapDeadEntries();
  context.ensureOpen();
  let resolved = resolveHostAttachmentEntry(
    context.entries,
    context.sessionOwners,
    prepared.signature,
    options.sessionId,
  );
  if (resolved.retirement) {
    await retireCodexSessionHost({
      ...resolved.retirement,
      sessionId: options.sessionId,
      ...(options.signal ? { signal: options.signal } : {}),
      close: (entry) => context.closeEntry(entry, 'session_migration'),
    });
    context.ensureOpen();
    resolved = resolveHostAttachmentEntry(
      context.entries,
      context.sessionOwners,
      prepared.signature,
      options.sessionId,
    );
  }
  let entry = resolved.entry;
  let reusedSessionHost = resolved.reusedSessionHost;
  if (!entry) entry = await context.spawnEntry(prepared);
  context.ensureOpen();
  if (!entry.host.isAlive) {
    await context.closeEntry(entry, 'dead');
    context.ensureOpen();
    entry = await context.spawnEntry(prepared);
    context.ensureOpen();
    reusedSessionHost = false;
  }
  context.sessionOwners.set(options.sessionId, entry);
  acquireAttachment(entry, context);
  try {
    const connection = await context.connectEntry(entry);
    return wrapAttachedHostConnection({
      connection,
      reusedSessionHost,
      releaseAttachment: () => releaseAttachment(entry, context),
    });
  } catch (error) {
    dropAttachment(entry);
    if (!entry.lease) await context.closeEntry(entry, 'connect_failed');
    throw error;
  }
}

function acquireAttachment(entry: HostEntry, context: HostAttachmentContext): void {
  if (entry.warm) context.recordWarmReuse();
  entry.warm = false;
  entry.attachmentCount++;
  entry.lastUsedAt = Date.now();
  context.clearIdleTimer(entry);
}

function dropAttachment(entry: HostEntry): void {
  if (entry.attachmentCount > 0) entry.attachmentCount--;
}

async function releaseAttachment(entry: HostEntry, context: HostAttachmentContext): Promise<void> {
  dropAttachment(entry);
  if (entry.attachmentCount === 0 && !entry.lease) await context.releaseEntry(entry);
}
