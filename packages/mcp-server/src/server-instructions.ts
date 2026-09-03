import type { McpServerFamily } from './tool-governance-snapshot.js';

/**
 * Provider-neutral retrieval indexes for the six split MCP servers.
 * Keep the first sentence self-contained: hosts may index only that sentence.
 */
export const SERVER_INSTRUCTIONS = {
  collab:
    'Collaboration actions for messages, threads, tasks, reviews, schedules, and runtime coordination live on this server. Search this server when the request involves communicating with another cat, reading or updating thread work, routing review, managing a task or workflow, scheduling work, or controlling a governed runtime action.',
  memory:
    'Memory recall, evidence search, graph navigation, session history, knowledge libraries, and distillation live on this server. Search this server when the request asks what happened before, why a decision was made, where evidence came from, what changed, or how to inspect a stored session or knowledge artifact.',
  signals:
    'Signal and friction intake, inbox search, source inspection, study, and article lifecycle actions live on this server. Search this server when the request mentions signals, friction reports, incoming evidence, studying or summarizing an external item, or managing a signal-backed article.',
  limb: 'Paired external capabilities, device or service limbs, embodiment, discovery, and governed invocation live on this server. Search this server when the request needs to find an available limb, inspect its tools, pair or approve access, invoke a remote capability, or manage an embodied runtime.',
  audio:
    'Audio capture, upload, recording control, transcription, and audio artifact actions live on this server. Search this server when the request asks to record, stop, transcribe, inspect, or manage audio rather than only discuss audio in text.',
  finance:
    'Read-only finance facts, fund lookup, market data, holdings, and performance queries live on this server. Search this server when the request asks for a financial instrument, fund, quote, portfolio fact, return, or other sourced finance data.',
} as const satisfies Readonly<Record<McpServerFamily, string>>;
