import type { Readable } from 'node:stream';
import { z } from 'zod';

/** Commands on the worker-to-Host side of the stdio connection. */
export type AgentAccessAcpProcessCommand =
  | { kind: 'write'; line: string }
  | { kind: 'shutdown'; graceMs: number; endStdin: boolean }
  | { kind: 'capacity'; message: string; timestamp: number };

export type AgentAccessAcpProcessTermination =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; message: string };

const processId = z.string().uuid();
const sessionId = z.string().min(1);
const sessionRequest = {
  processId,
  cwd: z.string().min(1),
  mcp: z.array(z.object({ ref: z.string().min(1), transport: z.enum(['stdio', 'http', 'sse']) })),
};
const limits = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  idleWarningMs: z.number().int().nonnegative().optional(),
  idleStallMs: z.number().int().nonnegative().optional(),
});

export const agentAccessAcpSessionOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('newSession'), ...sessionRequest }),
  z.object({ operation: z.literal('loadSession'), ...sessionRequest, sessionId }),
  z.object({ operation: z.literal('resumeSession'), ...sessionRequest, sessionId }),
  z.object({ operation: z.literal('closeSession'), processId, sessionId }),
  z.object({ operation: z.literal('setModel'), processId, sessionId, modelId: z.string().min(1) }),
  z.object({ operation: z.literal('setConfig'), processId, sessionId, configId: z.string().min(1), value: z.string() }),
  z.object({ operation: z.literal('cancel'), processId, sessionId }),
  z.object({
    operation: z.literal('prompt'),
    processId,
    sessionId,
    contentRef: z.string().min(1),
    limits: limits.optional(),
  }),
]);

export type AgentAccessAcpSessionOperation = z.infer<typeof agentAccessAcpSessionOperationSchema>;

export const agentAccessAcpSessionFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('protocol'), code: z.number(), message: z.string(), data: z.unknown().optional() }),
  z.object({ kind: z.literal('binding'), message: z.string() }),
  z.object({ kind: z.literal('timeout'), method: z.string(), timeoutMs: z.number() }),
  z.object({
    kind: z.literal('idle'),
    sessionId,
    idleSinceMs: z.number(),
    eventCount: z.number(),
    configuredIdleStallMs: z.number().optional(),
  }),
  z.object({ kind: z.literal('cancelled'), sessionId }),
  z.object({ kind: z.literal('other'), message: z.string() }),
]);
export type AgentAccessAcpSessionFailure = z.infer<typeof agentAccessAcpSessionFailureSchema>;

export const agentAccessAcpTurnFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update'), update: z.object({ sessionId, update: z.record(z.unknown()) }) }),
  z.object({
    kind: z.literal('terminal'),
    finalResponse: z.boolean(),
    sessionReusable: z.boolean(),
    processReusable: z.boolean(),
    result: z.union([
      z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }),
      z.object({ failure: agentAccessAcpSessionFailureSchema }),
    ]),
  }),
]);

export type AgentAccessAcpTurnFrame =
  | { kind: 'update'; update: AcpSessionUpdate }
  | {
      kind: 'terminal';
      finalResponse: boolean;
      sessionReusable: boolean;
      processReusable: boolean;
      result: { stopReason: AcpStopReason } | { failure: AgentAccessAcpSessionFailure };
    };

export const agentAccessAcpModelSelectionSchema = z.object({
  model: z.string().min(1),
  configOptions: z.unknown().optional(),
});

export const agentAccessAcpModelSelectionResultSchema = z.object({ configId: z.string().min(1) }).nullable();

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
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel', // notification (no response)
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionSetModel: 'session/set_model',

  // Agent → Client notifications
  sessionUpdate: 'session/update',

  // Agent → Client requests (we must respond)
  requestPermission: 'session/request_permission',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',

  // iCode (Chrys) private extension requests
  chrysRequestInput: '_chrys/request_input',
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
    loadSession?: boolean;
    sessionCapabilities?: {
      resume?: Record<string, unknown>;
      list?: Record<string, unknown>;
      close?: Record<string, unknown>;
    };
    _meta?: Record<string, unknown>;
    promptCapabilities?: AcpPromptCapabilities;
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

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

// ─── Session ───────────────────────────────────────────────────

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
  _meta?: Record<string, unknown>;
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpSessionConfigOption[];
  modes?: {
    availableModes: Array<{ id: string; name: string; description: string }>;
    currentModeId: string;
  };
  models?: {
    availableModels: Array<{ id: string; name: string }>;
    currentModelId: string;
  };
}

export interface AcpSessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string; description?: string }>;
  [key: string]: unknown;
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
  | 'usage_update'
  | 'provider_capacity_signal' // F149: injected by AcpClient.promptStream from stderr
  | 'stream_idle_warning' // F149: injected by AcpClient.promptStream idle watchdog
  | 'stream_tool_wait_warning'; // tool_call pending — idle is expected, not a stall

/** Tool result entries include nested content, diffs, terminals, or future extension blocks. */
export interface AcpToolCallContent {
  type: string;
  [key: string]: unknown;
}

export interface AcpSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: AcpSessionUpdateType;
    content?: AcpContentBlock | AcpToolCallContent[];
    rawInput?: unknown;
    rawOutput?: unknown;
    [key: string]: unknown;
  };
}

// ─── MCP Server Config (passed to session/new) ────────────────

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

export interface AcpMcpServerStdio {
  /** Host provenance; removed by materialization before the native RPC. */
  hostSource?: 'plugin';
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
export type AgentAccessAcpChildTermination =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'error'; readonly error: Error };

/** The Host launches exactly the process it admitted and transfers only its pipes and lifecycle. */
export interface AgentAccessAcpChildHandle {
  readonly pid?: number;
  readonly stdout: Readable;
  readonly stderr?: Readable | null;
  isWritable(): boolean | Promise<boolean>;
  isKilled(): boolean | Promise<boolean>;
  write(line: string): void | Promise<void>;
  termination(): Promise<AgentAccessAcpChildTermination>;
  shutdown(graceMs: number, endStdin: boolean): Promise<void>;
}

export const agentAccessDshConnectionInputSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).max(512).optional(),
  effort: z.string().min(1).max(160).optional(),
});
export type AgentAccessDshConnectionInput = z.infer<typeof agentAccessDshConnectionInputSchema>;
