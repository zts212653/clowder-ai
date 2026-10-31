import {
  type SidebarCommandField,
  type SidebarCommandValueMap,
  useSidebarProjectionStore,
} from '@/stores/sidebarProjectionStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

interface CommandResponse {
  readonly ok: boolean;
}

export interface SidebarFieldCommand<F extends SidebarCommandField> {
  readonly threadId: string;
  readonly field: F;
  readonly value: SidebarCommandValueMap[F];
  readonly request: (signal: AbortSignal) => Promise<CommandResponse>;
  readonly timeoutMs?: number;
}

const commandQueues = new Map<string, Promise<unknown>>();
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

function queueKey(threadId: string, field: SidebarCommandField): string {
  return `${threadId}\u0000${field}`;
}

export async function executeSidebarFieldCommand<F extends SidebarCommandField>(
  command: SidebarFieldCommand<F>,
): Promise<boolean> {
  const store = useSidebarProjectionStore.getState();
  const commandId = store.beginSidebarCommand(command.threadId, command.field, command.value);
  const key = queueKey(command.threadId, command.field);
  const previous = commandQueues.get(key) ?? Promise.resolve();

  const execution = previous
    .catch(() => {})
    .then(async () => {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          command.request(controller.signal).then(
            (value) => ({ kind: 'response' as const, value }),
            () => ({ kind: 'request-error' as const }),
          ),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: 'timeout' }), command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
          }),
        ]);
        if (response.kind === 'timeout') {
          controller.abort();
          store.failSidebarCommand(commandId);
          await invalidateSidebarProjection();
          return false;
        }
        if (response.kind === 'request-error') {
          store.failSidebarCommand(commandId);
          return false;
        }
        if (!response.value.ok) {
          store.failSidebarCommand(commandId);
          return false;
        }
        await invalidateSidebarProjection();
        return true;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });

  commandQueues.set(key, execution);
  void execution.finally(() => {
    if (commandQueues.get(key) === execution) commandQueues.delete(key);
  });
  return execution;
}

export function __resetSidebarCommandQueuesForTests(): void {
  commandQueues.clear();
}
