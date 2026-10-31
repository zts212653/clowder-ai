import { shellSegments, shellSubstitutions } from './shell-lexical.mjs';

/** A substitution's output is argv data; its body is read separately as executed source. */
// NUL cannot be a native argv word. Literal marker-like prose remains data.
export const SUBSTITUTION = '\0catcafe_substitution';
export function unquote(value) {
  return value?.replace(/^(['"])(.*)\1$/, '$2');
}

export function splitCommandLines(raw, { groups = false } = {}) {
  return shellSegments(raw, { pipelines: false, groups }).segments.map(({ text }) => text);
}

export function splitPipelineStages(raw) {
  return shellSegments(raw, { lines: false, execution: false }).segments.map(({ text }) => text);
}

export function extractSubstitutions(raw, options) {
  return shellSubstitutions(raw, SUBSTITUTION, options);
}
