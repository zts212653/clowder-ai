import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { PersistenceContext } from './route-helpers.js';

const log = createModuleLogger('route-system-info-persistence');

function parseVisibleNotice(
  content: string,
  catId: string,
):
  | {
      content: string;
      connector: string;
      label: string;
      icon: string;
      tone: 'info' | 'warning';
    }
  | undefined {
  try {
    const parsed = JSON.parse(content) as { type?: unknown; status?: unknown; message?: unknown };
    if (typeof parsed.message !== 'string') return undefined;
    if (parsed.type === 'warning') {
      return {
        content: parsed.message ? `⚠️ ${parsed.message}` : '⚠️ Warning',
        connector: 'system-warning',
        label: '系统警告',
        icon: '⚠️',
        tone: 'warning',
      };
    }
    if (parsed.type === 'a2a_multi_target_serialized') {
      return {
        content: parsed.message,
        connector: 'a2a-routing-mode',
        label: '调度模式',
        icon: '🔀',
        tone: 'info',
      };
    }
    if (parsed.type === 'cloud_bridge_status') {
      const unavailable = parsed.status === 'unavailable';
      return {
        content: parsed.message,
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: unavailable ? '⚠️' : '☁️',
        tone: unavailable ? 'warning' : 'info',
      };
    }
    return undefined;
  } catch (parseErr) {
    log.warn({ catId, err: parseErr }, 'Ignoring non-JSON user-facing system_info content');
    return undefined;
  }
}

export async function persistUserFacingSystemInfoNotices(options: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  contents: readonly string[];
  persistenceContext?: PersistenceContext;
}): Promise<void> {
  const { messageStore, threadId, catId, contents, persistenceContext } = options;

  for (const content of contents) {
    const notice = parseVisibleNotice(content, catId);
    if (notice == null) continue;

    try {
      await messageStore.append({
        userId: 'system',
        catId: null,
        threadId,
        content: notice.content,
        mentions: [],
        timestamp: Date.now(),
        source: {
          connector: notice.connector,
          label: notice.label,
          icon: notice.icon,
          meta: { presentation: 'system_notice', noticeTone: notice.tone },
        },
      });
    } catch (persistErr) {
      log.error({ catId, err: persistErr }, 'Failed to persist user-facing system_info notice');
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
