/**
 * RelayClaw Agent Types
 *
 * Configuration and wire-protocol types for connecting to a relay-claw
 * AgentWebSocketServer (openJiuwen agent exposed via WebSocket).
 */

/** Configuration for connecting to a relay-claw agent server */
export interface RelayClawAgentConfig {
  /** WebSocket endpoint URL (e.g. "ws://127.0.0.1:18092") */
  url?: string;
  /** Request timeout in ms (default: 180_000 — agent tasks can be long) */
  timeoutMs?: number;
  /** Channel ID sent in requests (default: "catcafe") */
  channelId?: string;
  /** Start a dedicated local jiuwenclaw sidecar when url is not provided */
  autoStart?: boolean;
  /** Python executable used to launch relay-claw */
  pythonBin?: string;
  /** relay-claw repository / package working directory */
  appDir?: string;
  /** Dedicated HOME for this cat's relay-claw runtime */
  homeDir?: string;
  /** Model name injected into sidecar env */
  modelName?: string;
  /** Optional fixed agent port for the sidecar */
  agentPort?: number;
  /** Optional fixed web port for the sidecar */
  webPort?: number;
  /** Sidecar boot timeout in ms */
  startupTimeoutMs?: number;
}

/**
 * Inbound event types from the relay-claw agent stream.
 * Maps to EventType enum in jiuwenclaw/schema/message.py.
 */
export type RelayClawEventType =
  | 'chat.delta'
  | 'chat.final'
  | 'chat.tool_call'
  | 'chat.tool_result'
  | 'chat.error'
  | 'chat.processing_status'
  | 'chat.ask_user_question'
  | 'chat.media'
  | 'chat.file'
  | 'chat.interrupt_result'
  | 'chat.subtask_update'
  | 'chat.session_result'
  | 'context.compressed'
  | 'todo.updated'
  | 'connection.ack';

/** A streaming chunk received from the relay-claw agent WS server */
export interface RelayClawChunkPayload {
  event_type?: RelayClawEventType;
  content?: string;
  error?: string;
  tool_call?: Record<string, unknown>;
  tool_name?: string;
  tool_call_id?: string;
  result?: string;
  is_complete?: boolean;
  is_processing?: boolean;
  current_task?: string;
  todos?: unknown[];
  source_chunk_type?: string;
  [key: string]: unknown;
}

/** Raw WS frame from the relay-claw agent (both chunk and response) */
export interface RelayClawWsFrame {
  /** Present on connection.ack event frames */
  type?: 'event';
  event?: string;
  /** Present on request-correlated frames */
  request_id?: string;
  channel_id?: string;
  ok?: boolean;
  payload?: RelayClawChunkPayload | null;
  is_complete?: boolean;
  metadata?: Record<string, unknown>;
}
