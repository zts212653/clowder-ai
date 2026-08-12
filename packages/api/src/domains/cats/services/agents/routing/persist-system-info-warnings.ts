import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { PersistenceContext } from './route-helpers.js';

const log = createModuleLogger('route-system-info-persistence');

function parseWarningMessage(content: string, catId: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { type?: unknown; message?: unknown };
    return parsed.type === 'warning' && typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch (parseErr) {
    log.warn({ catId, err: parseErr }, 'Ignoring non-JSON user-facing system_info content');
    return undefined;
  }
}

export async function persistUserFacingSystemInfoWarnings(options: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  contents: readonly string[];
  persistenceContext?: PersistenceContext;
}): Promise<void> {
  const { messageStore, threadId, catId, contents, persistenceContext } = options;

  for (const content of contents) {
    const message = parseWarningMessage(content, catId);
    if (message == null) continue;

    try {
      await messageStore.append({
        userId: 'system',
        catId: null,
        threadId,
        content: message ? `⚠️ ${message}` : '⚠️ Warning',
        mentions: [],
        timestamp: Date.now(),
        source: {
          connector: 'system-warning',
          label: '系统警告',
          icon: '⚠️',
          meta: { presentation: 'system_notice', noticeTone: 'warning' },
        },
      });
    } catch (persistErr) {
      log.error({ catId, err: persistErr }, 'Failed to persist user-facing system_info warning');
      if (persistenceContext) {
        persistenceContext.failed = true;
        persistenceContext.errors.push({
          catId,
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
  }
}
