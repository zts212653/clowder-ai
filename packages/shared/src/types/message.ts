/**
 * Message Types
 * 消息相关的类型定义
 */

import type { ContextAttachmentContent } from './context-attachment.js';
import type { CatId, MessageId, ThreadId, UserId } from './ids.js';
import { generateMessageId } from './ids.js';

/**
 * Message sender - user or cat
 */
export type MessageSender =
  | { readonly type: 'user'; readonly userId: UserId }
  | { readonly type: 'cat'; readonly catId: CatId };

/**
 * Text content
 */
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Image content
 */
export interface ImageContent {
  readonly type: 'image';
  readonly url: string;
  readonly alt?: string;
}

/**
 * Generic file content — non-image file attachments.
 * Images use ImageContent (keeps preview + lightbox path).
 * FileContent carries enough metadata to render a file card with download
 * without re-fetching or parsing the file.
 */
export interface FileContent {
  readonly type: 'file';
  readonly url: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
}

/**
 * Code content
 */
export interface CodeContent {
  readonly type: 'code';
  readonly code: string;
  readonly language?: string;
  readonly filename?: string;
}

/**
 * Tool call content
 */
export interface ToolCallContent {
  readonly type: 'tool_call';
  readonly toolName: string;
  readonly toolId: string;
  readonly input: Record<string, unknown>;
}

/**
 * Tool result content
 */
export interface ToolResultContent {
  readonly type: 'tool_result';
  readonly toolId: string;
  readonly result: unknown;
  readonly isError?: boolean;
}

/**
 * Message content - union of all content types
 */
export type MessageContent =
  | TextContent
  | ImageContent
  | FileContent
  | CodeContent
  | ToolCallContent
  | ToolResultContent
  | ContextAttachmentContent;

/**
 * Message status
 */
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error';

/**
 * Complete message structure
 */
export interface Message {
  readonly id: MessageId;
  readonly threadId: ThreadId;
  readonly sender: MessageSender;
  readonly content: readonly MessageContent[];
  readonly status: MessageStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Agent stream message for real-time updates
 */
export type AgentStreamMessage =
  | { readonly type: 'start'; readonly messageId: MessageId }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'tool_call_start'; readonly toolName: string; readonly toolId: string }
  | { readonly type: 'tool_call_delta'; readonly toolId: string; readonly delta: string }
  | { readonly type: 'tool_call_end'; readonly toolId: string }
  | { readonly type: 'tool_result'; readonly toolId: string; readonly result: unknown }
  | { readonly type: 'complete'; readonly message: Message }
  | { readonly type: 'error'; readonly error: string };

/**
 * Create a user message
 */
export function createUserMessage(params: {
  readonly threadId: ThreadId;
  readonly userId: UserId;
  readonly content: readonly MessageContent[];
  readonly metadata?: Record<string, unknown>;
}): Message {
  const now = new Date();
  const result: Message = {
    id: generateMessageId(),
    threadId: params.threadId,
    sender: { type: 'user', userId: params.userId },
    content: params.content,
    status: 'complete',
    createdAt: now,
    updatedAt: now,
  };
  if (params.metadata !== undefined) {
    return { ...result, metadata: params.metadata };
  }
  return result;
}

/**
 * Create a cat message
 */
export function createCatMessage(params: {
  readonly threadId: ThreadId;
  readonly catId: CatId;
  readonly content: readonly MessageContent[];
  readonly status?: MessageStatus;
  readonly metadata?: Record<string, unknown>;
}): Message {
  const now = new Date();
  const result: Message = {
    id: generateMessageId(),
    threadId: params.threadId,
    sender: { type: 'cat', catId: params.catId },
    content: params.content,
    status: params.status ?? 'complete',
    createdAt: now,
    updatedAt: now,
  };
  if (params.metadata !== undefined) {
    return { ...result, metadata: params.metadata };
  }
  return result;
}
