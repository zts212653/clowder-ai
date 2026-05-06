import type { BubbleEventType, BubbleKind, BubbleOriginPhase, BubbleSourcePath } from '@cat-cafe/shared';
import type { BubbleEvent } from '@/stores/bubble-reducer';
import type { BackgroundAgentMessage } from './useAgentMessages';

interface AdapterOptions {
  sourcePath: BubbleSourcePath;
}

// Round 3 P1 (砚砚 + 云端 codex): assistant_text 改为白名单 — 只有 msg.type='text'
// 才归 assistant_text。未知/control msg.type（status / provider_signal / 未来新增）
// 默认归 system_status，让 deriveSystemStatusEventType 返回 undefined，caller 走
// chatStore.addMessage 而非 reducer。否则 terminal/control event 绑成 assistant_text
// stable key 是气泡裂/消失的复发路径（见 useAgentMessages.ts 真实 dispatch:
// status/provider_signal/system_info/a2a_handoff/done/error/timeout/tool_*/rich_*）。
function deriveKind(msgType: string): BubbleKind {
  if (msgType === 'text') return 'assistant_text';
  if (msgType === 'thinking') return 'thinking';
  if (msgType === 'tool_use' || msgType === 'tool_result' || msgType === 'cli_output') return 'tool_or_cli';
  if (msgType === 'rich_block') return 'rich_block';
  // 默认 fallback：所有非白名单 type → system_status（含未知 control/未来扩展）。
  return 'system_status';
}

// Round 1 P1 (砚砚): system_status 不默认 emit done — 普通 system_info /
// a2a_handoff 不是 terminal event，adapter 返回 undefined 让 caller 决定
// 走 chatStore.addMessage 而非 reducer。terminal/error/timeout 显式 emit。
// Round 2 P1 (砚砚): direct msg.type='done'/'error' 优先于 inferred
// (msg.error / msg.isFinal) — 显式 terminal type 是真相源。
function deriveSystemStatusEventType(msg: BackgroundAgentMessage): BubbleEventType | undefined {
  if (msg.type === 'timeout') return 'timeout';
  if (msg.type === 'done') return 'done';
  if (msg.type === 'error') return 'error';
  if (msg.error) return 'error';
  if (msg.isFinal) return 'done';
  return undefined;
}

// Round 4 P1 (云端 codex): msg.type='text' + isFinal=true + content 必须保持
// stream_chunk —— BubbleReducer 里只有 stream_chunk / callback_final 写 content，
// 'done' 不 mutate content。如果 final text 走 done，最后一段 assistant text 会
// 直接被 drop（用户层 = "猫猫发完最后一段没显示"）。terminal 闭合走 msg.type='done'
// 单独 dispatch（路由层会发独立的 done msg），不靠 text+isFinal 推断。
function deriveAssistantTextEventType(msg: BackgroundAgentMessage): BubbleEventType {
  if (msg.origin === 'callback') return 'callback_final';
  return 'stream_chunk';
}

function deriveEventType(msg: BackgroundAgentMessage, kind: BubbleKind): BubbleEventType | undefined {
  if (kind === 'thinking') return 'thinking_chunk';
  if (kind === 'tool_or_cli') return msg.type === 'cli_output' ? 'cli_output' : 'tool_event';
  if (kind === 'rich_block') return 'rich_block';
  if (kind === 'system_status') return deriveSystemStatusEventType(msg);
  return deriveAssistantTextEventType(msg);
}

function derivePhase(msg: BackgroundAgentMessage): BubbleOriginPhase {
  if (msg.origin === 'callback') return 'callback/history';
  return 'stream';
}

/**
 * F183 Phase B1.2 adapter: map incoming `BackgroundAgentMessage` to `BubbleEvent`
 * for `applyBubbleEvent` consumption. Pure function; reducer- and UI-agnostic.
 *
 * Mapping rules (assistant_text is whitelist; non-text default 走 system_status undefined):
 *   - msg.type='text' + origin='stream' → stream_chunk + assistant_text
 *   - msg.type='text' + origin='callback' → callback_final + assistant_text
 *   - msg.type='thinking' → thinking_chunk + thinking
 *   - msg.type='tool_use' / 'tool_result' → tool_event + tool_or_cli
 *   - msg.type='cli_output' → cli_output + tool_or_cli
 *   - msg.type='rich_block' → rich_block + rich_block
 *   - msg.type='timeout' → timeout + system_status
 *   - msg.type='done' → done + system_status
 *   - msg.type='error' → error + system_status
 *   - msg.type='system_info' + isFinal/error → done|error + system_status
 *   - msg.type='system_info' / 'a2a_handoff' / 'status' / 'provider_signal' / unknown
 *       → undefined（caller 走 chatStore.addMessage，不进 reducer）
 */
export function adaptIncomingToBubbleEvent(
  msg: BackgroundAgentMessage,
  options: AdapterOptions,
): BubbleEvent | undefined {
  const kind = deriveKind(msg.type);
  const eventType = deriveEventType(msg, kind);
  // Round 1 P1: caller must handle undefined (non-terminal system messages)
  if (!eventType) return undefined;
  const phase = derivePhase(msg);

  const payload: Record<string, unknown> = {};
  if (msg.content !== undefined) payload.content = msg.content;
  if (msg.toolName) payload.toolName = msg.toolName;
  if (msg.toolInput) payload.toolInput = msg.toolInput;
  if (msg.error) payload.error = msg.error;
  if (msg.errorCode) payload.errorCode = msg.errorCode;
  // Round 5 P1 (云端 codex): 透传 textMode='replace' — useAgentMessages.ts:991 真实
  // 用 replace 走 patchThreadMessage 重写 bubble，不是 append。adapter 不传 textMode
  // + reducer 不识别 → B1.2.2 wire 进 active stream 后 replace 会被当 append（content
  // 累加 = 重复显示）。
  if (msg.textMode) payload.textMode = msg.textMode;

  return {
    type: eventType,
    threadId: msg.threadId,
    actorId: msg.catId,
    canonicalInvocationId: msg.invocationId,
    bubbleKind: kind,
    originPhase: phase,
    sourcePath: options.sourcePath,
    messageId: msg.messageId,
    timestamp: msg.timestamp,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  };
}
