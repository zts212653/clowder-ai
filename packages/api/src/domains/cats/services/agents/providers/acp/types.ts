/**
 * ACP (Agent Client Protocol) type definitions
 *
 * Protocol reference: https://agentclientprotocol.com/protocol/overview
 * Verified against @agentclientprotocol/sdk v1 + Gemini CLI 0.35.3 spike.
 *
 * These types model what WE send/receive as the ACP **client** talking
 * to an ACP agent (e.g. `gemini --acp`) over stdin/stdout NDJSON.
 */

// ─── JSON-RPC 2.0 Envelope ────────────────────────────────────

/** Outgoing request from client to agent */
export interface AcpRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Incoming response from agent (correlates by id) */
export interface AcpResponse {
  jsonrpc: '2.0';
  id: string;
  result?: Record<string, unknown>;
  error?: AcpError;
}

/** Incoming notification from agent (no id) */
export interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

/** Incoming request from agent that expects our response (has id + method) */
export interface AcpAgentRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── Method Constants ──────────────────────────────────────────

export const ACP_METHODS = {
  // Client → Agent requests
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel', // notification (no response)
  sessionSetMode: 'session/set_mode',
  sessionSetModel: 'session/set_model',

  // Agent → Client notifications
  sessionUpdate: 'session/update',

  // Agent → Client requests (we must respond)
  requestPermission: 'session/request_permission',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',
} as const;

// ─── Initialize ────────────────────────────────────────────────

export interface AcpInitializeParams {
  protocolVersion: number;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  authMethods: AcpAuthMethod[];
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: {
      http?: boolean;
      sse?: boolean;
    };
  };
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description: string;
  _meta?: Record<string, unknown>;
}

// ─── Session ───────────────────────────────────────────────────

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: {
    availableModes: Array<{ id: string; name: string; description: string }>;
    currentModeId: string;
  };
  models?: {
    availableModels: Array<{ id: string; name: string }>;
    currentModelId: string;
  };
}

export interface AcpLoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
}

// ─── Prompt ────────────────────────────────────────────────────

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

// ─── Content ───────────────────────────────────────────────────

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

// ─── Session Update (streaming notifications) ──────────────────

export type AcpSessionUpdateType =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'provider_capacity_signal' // F149: injected by AcpClient.promptStream from stderr
  | 'stream_idle_warning' // F149: injected by AcpClient.promptStream idle watchdog
  | 'stream_tool_wait_warning'; // tool_call pending — idle is expected, not a stall

export interface AcpSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: AcpSessionUpdateType;
    content?: AcpContentBlock;
    [key: string]: unknown;
  };
}

// ─── MCP Server Config (passed to session/new) ────────────────

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpMcpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface AcpMcpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

// ─── Permission Request (agent asks client to approve tool use) ─

export interface AcpPermissionRequest {
  sessionId: string;
  options: Array<{
    optionId: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    name: string;
  }>;
  [key: string]: unknown;
}

// ─── Provider Profile ──────────────────────────────────────────

/** Configuration for spawning + managing an ACP agent process */
export interface AcpProviderProfile {
  /** CLI command to start the ACP server (e.g. 'gemini') */
  command: string;
  /** Startup args (e.g. ['--acp']) */
  startupArgs: string[];
  /** MCP servers to pass in session/new. Empty = use agent's own config. */
  mcpServers: AcpMcpServer[];
  /** Default model override (agent may still choose its own) */
  model?: string;
  /** Whether this carrier supports cross-session concurrent prompts (default false). */
  supportsMultiplexing: boolean;
}

// ─── Timing / Benchmark ────────────────────────────────────────

/** Timing results from a single ACP lifecycle measurement */
export interface AcpTimingResult {
  coldInitMs: number;
  newSessionMs: number;
  firstPromptFirstChunkMs: number;
  firstPromptTotalMs: number;
  warmPromptFirstChunkMs: number;
  warmPromptTotalMs: number;
}
