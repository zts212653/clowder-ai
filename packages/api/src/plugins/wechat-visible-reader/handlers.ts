import type { InvokeHandler } from '../../domains/limb/PluginLimbAdapter.js';
import type { WeChatVisibleReaderNativeRunner, WeChatVisibleReadOptions } from './native-runner.js';
import type { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import type { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';

export interface WeChatVisibleReaderHandlerDeps {
  armStore: WeChatVisibleReaderArmStore;
  metrics: WeChatVisibleReaderMetrics;
  runner: WeChatVisibleReaderNativeRunner;
}

export function createWeChatVisibleReaderHandlers(deps: WeChatVisibleReaderHandlerDeps): Record<string, InvokeHandler> {
  const readVisibleConversation: InvokeHandler = async (params) => {
    if (!deps.armStore.isArmed()) {
      return {
        success: true,
        data: {
          ok: false,
          error: {
            code: 'authorization_required',
            userAction: '请由本机 owner 在 Plugin Hub 中短时授权微信正文读取。',
          },
        },
      };
    }

    const options: WeChatVisibleReadOptions = {};
    if (params.maxBlocks !== undefined) options.maxBlocks = params.maxBlocks as number;
    if (params.maxChars !== undefined) options.maxChars = params.maxChars as number;
    const result = await deps.runner.read(options);
    deps.metrics.record(result);
    return { success: true, data: result };
  };

  const readConversationRecent: InvokeHandler = async (params, context) => {
    const invocation = context.invocation;
    const hasTrustedOwnerMessage = Boolean(
      invocation?.catId &&
        invocation.invocationId &&
        invocation.userId &&
        invocation.threadId &&
        invocation.userMessageId,
    );
    if (!hasTrustedOwnerMessage || params.acknowledgeUiNavigation !== true || params.acknowledgeMayMarkRead !== true) {
      return {
        success: true,
        data: {
          ok: false,
          error: {
            code: 'authorization_required',
            userAction: '请由 owner 在当前 thread 明确授权本次微信前台导航，并确认可能清除目标会话未读。',
          },
        },
      };
    }

    const contact = typeof params.contact === 'string' ? params.contact.trim() : '';
    const limit = params.limit;
    const containsControlCharacter = [...contact].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (
      contact.length === 0 ||
      [...contact].length > 128 ||
      containsControlCharacter ||
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      return {
        success: true,
        data: {
          ok: false,
          error: {
            code: 'navigation_failed',
            userAction: '联系人必须是 1-128 个可见字符，读取条数必须是 1-30 的整数。',
          },
        },
      };
    }

    const result = await deps.runner.readConversationRecent({ contact, limit });
    return { success: true, data: result };
  };

  return {
    'wechat-visible-reader:read_visible_conversation': readVisibleConversation,
    'wechat-visible-reader:read_conversation_recent': readConversationRecent,
  };
}
