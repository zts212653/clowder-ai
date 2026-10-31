import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';

// One qualified AGY vocabulary shared with the pre-effect hook. Components are
// model-request tools; init also names inactive tools that cannot be components.
const root = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
const vocabulary: Record<string, unknown> = JSON.parse(
  readFileSync(join(root, 'assets/agy-native-tool-vocabulary.json'), 'utf8'),
);
function names(key: string): readonly string[] {
  const value = vocabulary[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid qualified AGY tool vocabulary: ${key}`);
  }
  return value;
}
export const AGY_NATIVE_TOOLS = names('components');
export const AGY_NATIVE_READ_TOOLS = names('readOnlyComponents');
export const AGY_NATIVE_MCP_TOOLS = names('mcpResourceTools');
export const AGY_NATIVE_PROTOCOL_TOOLS = new Set([
  ...names('fileWriters'),
  ...names('commands'),
  ...names('unsupportedEffects'),
  ...names('delegatedTools'),
]);
