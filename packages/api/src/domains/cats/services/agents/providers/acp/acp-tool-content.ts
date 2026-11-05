/** Display projection only; native payloads remain separately available for transcript audit. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeBlock(value: unknown): string {
  if (!isRecord(value)) return '[unknown] Unsupported tool content; original payload retained.';
  const type = typeof value.type === 'string' ? value.type : 'unknown';
  if (type === 'content') return describeBlock(value.content);
  if (type === 'text' && typeof value.text === 'string') return value.text;
  if (type === 'diff') {
    return `[diff] ${typeof value.path === 'string' ? value.path : ''}\n${JSON.stringify({
      oldText: value.oldText,
      newText: value.newText,
    })}`;
  }
  if (type === 'resource_link') {
    return `[resource_link] ${typeof value.uri === 'string' ? value.uri : ''}`;
  }
  if (type === 'resource' && isRecord(value.resource)) {
    const resource = value.resource;
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    return typeof resource.text === 'string'
      ? `[resource] ${uri}\n${resource.text}`
      : `[resource] ${uri} Binary preview unavailable; original payload retained.`;
  }
  if (type === 'terminal') {
    return `[terminal] ${typeof value.terminalId === 'string' ? value.terminalId : ''} Live output unavailable; original payload retained.`;
  }
  return `[${type}] Not rendered in tool output; original payload retained.`;
}

export function toolResultText(payload: { content?: unknown; rawOutput?: unknown }): string {
  const content = payload.content;
  if (Array.isArray(content) && content.length > 0) return content.map(describeBlock).join('\n');
  if (isRecord(content)) return describeBlock(content);
  const raw = payload.rawOutput;
  return raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
}
