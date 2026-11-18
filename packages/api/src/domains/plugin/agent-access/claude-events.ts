import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function pick(value: unknown, keys: readonly string[]) {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

const usageFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const usage = (value: unknown) => ({
  ...pick(value, usageFields),
  cache_creation: pick(record(value).cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']),
});

/** SDK acknowledgements, echoed inputs, hook bodies and raw diagnostics stay on the Host. */
export function createClaudeEventBoundary(knownCredentials: readonly string[]) {
  let tail = '';
  let previous: { type: string; field: 'text' | 'thinking' } | undefined;
  return (raw: unknown) => {
    const provider = record(raw);
    const stream = record(provider.event);
    const delta = record(stream.delta);
    const field = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : undefined;
    const chunk =
      provider.type === 'stream_event' && stream.type === 'content_block_delta' && field ? delta[field] : undefined;
    const boundary =
      raw === null ||
      provider.type === 'assistant' ||
      provider.type === 'result' ||
      (provider.type === 'stream_event' &&
        (stream.type === 'message_start' ||
          stream.type === 'message_stop' ||
          (stream.type === 'content_block_stop' && previous?.field === 'thinking') ||
          (typeof chunk === 'string' && delta.type !== previous?.type)));
    const before =
      tail && previous && boundary
        ? {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: previous.type, [previous.field]: tail } },
          }
        : undefined;
    if (before) tail = '';
    let projected: unknown = null;
    let host = raw;
    switch (provider.type) {
      case 'stream_event': {
        let event: unknown;
        if (typeof chunk === 'string' && field && typeof delta.type === 'string') {
          const joined = sanitizeRawEvent(tail + chunk, knownCredentials);
          let safe = typeof joined === 'string' ? joined : '[REDACTED]';
          let pending = 0;
          for (const credential of knownCredentials) {
            for (let length = Math.min(credential.length - 1, safe.length); length > pending; length -= 1) {
              if (!safe.endsWith(credential.slice(0, length))) continue;
              pending = length;
              break;
            }
          }
          tail = pending ? safe.slice(-pending) : '';
          if (pending) safe = safe.slice(0, -pending);
          previous = { type: delta.type, field };
          event = { type: stream.type, delta: { type: delta.type, [field]: safe } };
          host = { ...provider, event };
        } else if (stream.type === 'message_start') {
          event = {
            type: stream.type,
            message: { ...pick(stream.message, ['id']), usage: usage(record(stream.message).usage) },
          };
        } else if (stream.type === 'message_delta') {
          event = { type: stream.type, usage: usage(stream.usage ?? delta.usage) };
        } else if (stream.type === 'content_block_start') {
          event = { type: stream.type, content_block: pick(stream.content_block, ['type']) };
        } else if (stream.type === 'message_stop' || stream.type === 'content_block_stop') {
          event = { type: stream.type };
        }
        if (event) projected = { type: provider.type, event };
        break;
      }
      case 'system':
        if (provider.subtype === 'init') {
          const servers = provider.mcp_servers;
          const mcp_servers = Array.isArray(servers)
            ? servers.map((server) => pick(server, ['name', 'status']))
            : Object.entries(record(servers)).map(([name, value]) => ({
                name,
                status: typeof value === 'string' ? value : record(value).status,
              }));
          projected = { type: provider.type, subtype: provider.subtype, session_id: provider.session_id, mcp_servers };
        } else if (provider.subtype === 'compact_boundary') {
          projected = pick(provider, ['type', 'subtype', 'pre_tokens']);
        }
        break;
      case 'assistant': {
        const message = record(provider.message);
        projected = {
          ...pick(provider, ['type', 'narration_block_indexes']),
          message: {
            ...pick(message, ['id', 'model']),
            content: Array.isArray(message.content)
              ? message.content.map((block) =>
                  pick(
                    block,
                    record(block).type === 'tool_use' ? ['type', 'id', 'name', 'input'] : ['type', 'text', 'thinking'],
                  ),
                )
              : undefined,
          },
        };
        break;
      }
      case 'rate_limit_event': {
        const info = record(provider.rate_limit_info);
        projected = {
          ...pick(provider, ['type', 'utilization', 'resets_at']),
          rate_limit_info: {
            ...pick(info, ['utilization', 'resetsAt']),
            unifiedWindows: Object.fromEntries(
              Object.entries(record(info.unifiedWindows)).map(([key, window]) => [
                key,
                pick(window, ['utilization', 'resetsAt', 'status']),
              ]),
            ),
          },
        };
        break;
      }
      case 'result':
        projected = {
          ...pick(provider, [
            'type',
            'subtype',
            'is_error',
            'errors',
            'total_cost_usd',
            'duration_ms',
            'duration_api_ms',
            'num_turns',
          ]),
          ...(provider.is_error === true || provider.subtype !== 'success' ? pick(provider, ['result']) : {}),
          usage: usage(provider.usage),
          modelUsage: Object.values(record(provider.modelUsage ?? provider.model_usage)).map((model) =>
            pick(model, ['contextWindow', 'context_window']),
          ),
        };
        break;
    }
    return {
      before,
      host: sanitizeRawEvent(host, knownCredentials),
      projected: sanitizeRawEvent(projected, knownCredentials),
    };
  };
}
