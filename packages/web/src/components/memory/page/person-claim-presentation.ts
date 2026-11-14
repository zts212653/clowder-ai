import type { PersonClaim } from './people-types';

function readableKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function factValueParts(value: unknown, includeFieldNames = false, useBooleanWords = false): string[] {
  // The existing editor saves an edited object/array as text; interpret that form only for display.
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return [value];
    }
    return factValueParts(parsed, includeFieldNames, useBooleanWords);
  }
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => factValueParts(item, false, useBooleanWords));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      const parts = factValueParts(item, includeFieldNames, useBooleanWords);
      return includeFieldNames && parts.length ? [`${readableKey(key)} ${parts.join('，')}`] : parts;
    });
  }
  const text = useBooleanWords && typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  return text.trim() ? [text] : [];
}

export function personClaimText(payload: PersonClaim['payload'], approvedText?: string): string {
  if (payload.kind === 'redacted') return '这条内容已遗忘';
  if (approvedText?.trim()) return approvedText;
  if (payload.kind === 'user_assessment') return payload.statement;
  const parts = factValueParts(payload.value);
  const hasChinese = /\p{Script=Han}/u.test(parts.join(''));
  const value = (hasChinese ? parts : factValueParts(payload.value, true, true)).join('，') || '内容为空';
  if (!/^[a-z][a-z\d_. /-]*$/i.test(payload.predicate)) return `${payload.predicate}：${value}`;
  return hasChinese || parts.length === 0 ? value : `${readableKey(payload.predicate)}：${value}`;
}
