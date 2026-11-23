const messageKeys = ['type', 'id', 'role', 'status', 'phase', 'content'];
const callKeys = ['type', 'id', 'call_id', 'name', 'namespace', 'status', 'arguments', 'input'];
const resultKeys = ['type', 'id', 'call_id', 'status', 'output'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textContent(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        record(part) &&
        ['input_text', 'output_text'].includes(String(part.type)) &&
        typeof part.text === 'string' &&
        Object.keys(part).every((key) => key === 'type' || key === 'text'),
    )
  );
}

function textItem(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === 'additional_tools') {
    const literalTools = (tools: unknown): boolean =>
      Array.isArray(tools) &&
      tools.every(
        (tool) =>
          record(tool) &&
          typeof tool.name === 'string' &&
          (['function', 'custom'].includes(String(tool.type)) ||
            (tool.type === 'namespace' && literalTools(tool.tools))),
      );
    return (
      literalTools(value.tools) &&
      Object.entries(value).every(
        ([key, field]) =>
          ['type', 'id', 'role', 'tools'].includes(key) && (key === 'tools' || typeof field === 'string'),
      )
    );
  }
  let keys: readonly string[];
  let contentKey: string;
  switch (value.type) {
    case undefined:
    case 'message':
      if (!['user', 'assistant', 'system', 'developer'].includes(String(value.role))) return false;
      keys = messageKeys;
      contentKey = 'content';
      break;
    case 'function_call':
    case 'custom_tool_call':
      if (typeof value.name !== 'string' || typeof value.call_id !== 'string') return false;
      keys = callKeys;
      contentKey = value.type === 'function_call' ? 'arguments' : 'input';
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
      if (typeof value.call_id !== 'string') return false;
      keys = resultKeys;
      contentKey = 'output';
      break;
    default:
      return false;
  }
  return (
    textContent(value[contentKey]) &&
    Object.entries(value).every(
      ([key, field]) => keys.includes(key) && (key === contentKey || typeof field === 'string'),
    )
  );
}

/** Only explicit text can rely entirely on the current serialized request's token estimate. */
export function hasExplicitTextContext(body: Record<string, unknown>): boolean {
  // Server-owned context and stored prompt references are not proof of a fully expanded text history.
  if (body.conversation != null || body.context_management != null || body.prompt != null) return false;
  return typeof body.input === 'string' || (Array.isArray(body.input) && body.input.every(textItem));
}
