/**
 * A2A Protocol Types — F050 Phase 3
 *
 * Minimal subset of Google's Agent-to-Agent Protocol (v1.0)
 * for Clowder AI to communicate with remote agents.
 * Spec: https://a2a-protocol.org/latest/specification/
 */

// ─── A2A Protocol Types (upstream spec) ──────────────────────

/** A2A Task status (v1.0 uses SCREAMING_SNAKE_CASE in wire format, we use camelCase internally) */
export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required';

/** A2A Part — content unit in a message or artifact */
export interface A2APart {
  type: 'text' | 'file' | 'data';
  text?: string;
  file?: { name: string; mimeType: string; bytes?: string };
  data?: unknown;
}

/** A2A Artifact — structured output from a completed task */
export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: A2APart[];
}

/** A2A Message — communication unit in task history */
export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
}

/** A2A Task — the core unit of work */
export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
}

/** A2A JSON-RPC 2.0 response envelope */
export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: A2ATask;
  error?: { code: number; message: string; data?: unknown };
}

/** A2A AgentCard — describes a remote agent's capabilities */
export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  supportedInterfaces: string[];
  capabilities?: string[];
}

// ─── Clowder AI A2A Configuration ──────────────────────────────

/** Configuration for connecting to a remote A2A agent */
export interface A2AAgentConfig {
  /** Full JSON-RPC endpoint URL — POST target for tasks/send (e.g. "https://agent.local:8080/a2a") */
  url: string;
  /** API key for simple bearer token auth */
  apiKey?: string;
  /** Request timeout in ms (default: 120000) */
  timeoutMs?: number;
}
