/**
 * Lightweight template rendering and JSONPath extraction for protocol engine.
 * Covers {{var}}, {{var | default:value}}, {{var | base64}} patterns
 * and simple JSONPath like $.data.task_id, $.items[0].url
 */

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(TEMPLATE_RE, (_, expr: string) => {
    const parts = expr.split('|').map((s: string) => s.trim());
    const varName = parts[0];
    const value = vars[varName];

    for (let i = 1; i < parts.length; i++) {
      const filter = parts[i];
      if (filter.startsWith('default:') && (value === undefined || value === '')) {
        return filter.slice('default:'.length);
      }
      if (filter === 'base64' && value !== undefined) {
        return Buffer.from(value).toString('base64');
      }
    }

    if (value === undefined) return '';
    return value;
  });
}

export function renderBody(body: unknown, vars: Record<string, string>): unknown {
  if (typeof body === 'string') return renderTemplate(body, vars);
  if (Array.isArray(body)) return body.map((item) => renderBody(item, vars));
  if (body !== null && typeof body === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
      result[key] = renderBody(val, vars);
    }
    return result;
  }
  return body;
}

const JSONPATH_SEGMENT_RE = /\.?([^.[]+)|\[(\d+)\]/g;

export function extractJsonPath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;

  let current: unknown = obj;
  const segments = path.slice(1);
  let match: RegExpExecArray | null;
  JSONPATH_SEGMENT_RE.lastIndex = 0;

  while ((match = JSONPATH_SEGMENT_RE.exec(segments)) !== null) {
    if (current === null || current === undefined) return undefined;
    const key = match[1] ?? match[2];
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

export function extractString(obj: unknown, path: string): string | undefined {
  const val = extractJsonPath(obj, path);
  if (val === undefined || val === null) return undefined;
  return String(val);
}
