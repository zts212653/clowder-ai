import { createHash } from 'node:crypto';
import {
  type MessageOutputLayoutV1,
  type MessageOutputOwner,
  type MessageOutputSettlement,
  readOutputMessageIdentity,
} from '@cat-cafe/shared';
import { normalizeJsonUnicode } from '../../../../../utils/json-unicode.js';
import type { StoredToolEvent } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../message-output-accumulator.js';
import { nativeSignatureRemoval } from '../message-output-native-finalization.js';
import type { MessageOutputState } from '../message-output-state.js';
import type { OutputFragmentFacts } from '../message-output-stream-transform.js';
import { alignTrimmedToolBoundary } from './message-output-finalization.js';

/** One visible child owns the original route's transient body accumulator. */
export class RoutingMessageOutputProjection {
  private state: MessageOutputState;
  private settlement?: MessageOutputSettlement;
  constructor(readonly owner: MessageOutputOwner) {
    this.state = createMessageOutputState(owner);
  }

  text(message: AgentMessage, fragment?: OutputFragmentFacts): AgentMessage {
    const before = this.snapshot().content;
    const callback = message.origin === 'callback' || message.extra?.isExplicitPost;
    this.state = accumulateMessageOutputText(this.state, {
      content: message.content ?? '',
      textMode: callback ? 'replace' : message.textMode,
      outputMessage: callback ? undefined : message.outputMessage,
      hostOutput: callback ? undefined : message.hostOutput,
      nativeSignatureSuffix: callback ? undefined : nativeSignatureRemoval(message),
      ...(fragment ? { fragment } : {}),
    });
    if (callback) this.state = { ...this.state, reason: 'callback' };
    const snapshot = this.snapshot();
    const nativeDelta =
      !!readOutputMessageIdentity(message.outputMessage) &&
      message.outputMessage?.complete === false &&
      message.outputMessage.textMode === 'append';
    const incrementalAppend =
      (!readOutputMessageIdentity(message.outputMessage) || nativeDelta) &&
      (!message.hostOutput || snapshot.layout.status === 'unavailable') &&
      message.textMode !== 'replace' &&
      !callback &&
      snapshot.content.startsWith(before);
    return {
      ...message,
      content: incrementalAppend ? snapshot.content.slice(before.length) : snapshot.content,
      textMode: incrementalAppend ? 'append' : 'replace',
      extra: { ...message.extra, outputLayout: snapshot.layout },
    };
  }

  tool(event: StoredToolEvent): void {
    this.state = accumulateMessageOutputTool(this.state, event.id, event.executionRef ?? '');
  }

  settle(settlement: MessageOutputSettlement): void {
    this.settlement = settlement;
  }

  snapshot(content = materializeMessageOutput(this.state).content): {
    content: string;
    layout: MessageOutputLayoutV1;
  } {
    const original = materializeMessageOutput(this.state, this.settlement);
    const published = normalizeJsonUnicode(content);
    if (published === original.content) return original;
    const aligned = alignTrimmedToolBoundary(original.content, published, original.layout);
    if (aligned) return { content: published, layout: aligned };
    return {
      content: published,
      layout: {
        v: 1,
        owner: this.owner,
        status: 'unavailable',
        reason: 'content_changed',
        contentRevision: {
          length: published.length,
          sha256: createHash('sha256').update(published, 'utf8').digest('hex'),
        },
      },
    };
  }
}

export function outputLayoutExtra(projection: RoutingMessageOutputProjection | undefined, content?: string) {
  return projection ? { outputLayout: projection.snapshot(content).layout } : {};
}
