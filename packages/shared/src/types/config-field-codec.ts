/**
 * Config Field Value Codec — F240 KD-18
 *
 * Store layer is Record<string, string | null>. All typed values are
 * serialized/deserialized through this codec. The store never sees
 * booleans, arrays, or objects — only strings and null.
 *
 * Shared by frontend and backend (lives in @cat-cafe/shared).
 */

import type { ConfigField } from './config-field.js';

/**
 * Encode a typed value into its string storage representation.
 * Returns undefined for operation fields (they don't enter value store).
 */
export function encodeFieldValue(field: ConfigField, value: unknown): string | undefined {
  switch (field.type) {
    case 'input':
      return typeof value === 'string' ? value : String(value ?? '');

    case 'toggle':
      return value === true ? 'true' : 'false';

    case 'select':
      return typeof value === 'string' ? value : String(value ?? '');

    case 'list': {
      if (Array.isArray(value)) {
        return JSON.stringify(value.filter((v): v is string => typeof v === 'string'));
      }
      return '[]';
    }

    case 'operation':
      // Operation fields do not enter value store
      return undefined;
  }
}

/**
 * Decode a stored string into its typed value.
 * Returns undefined for operation fields or invalid values.
 *
 * Graceful: never throws. Invalid data → type-specific fallback.
 */
export function decodeFieldValue(field: ConfigField, stored: string): unknown {
  switch (field.type) {
    case 'input':
      return stored;

    case 'toggle':
      // Only exact "true" → true, everything else → false (graceful)
      return stored === 'true';

    case 'select': {
      // Validate against options list
      if ('options' in field && Array.isArray(field.options)) {
        const valid = field.options.some((opt) => opt.value === stored);
        return valid ? stored : undefined;
      }
      return stored;
    }

    case 'list': {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
          return parsed;
        }
        return [];
      } catch {
        return [];
      }
    }

    case 'operation':
      // Operation fields do not enter value store
      return undefined;
  }
}
