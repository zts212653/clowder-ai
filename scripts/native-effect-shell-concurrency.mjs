import { scanShellText } from './lib/shell-lexical.mjs';

// Shared segment boundaries; neither helper grants program or copy authority.
export function hasConcurrentShellExecution(lexical, raw, ignorePipelines = false) {
  const concurrentBoundary = lexical.boundaries.some(
    (boundary) =>
      (!ignorePipelines && boundary.kind === 'pipeline') ||
      (boundary.kind === 'execution' && raw.slice(boundary.start, boundary.end) === '&'),
  );
  return concurrentBoundary || lexical.substitutions.some((substitution) => /[<>]/.test(raw[substitution.start]));
}

export function pipelineChainStart(parts, index) {
  if (!['|', '|&'].includes(parts[index + 1]?.separator)) return index;
  let depth = 0;
  for (let cursor = index; cursor >= 0; cursor--) {
    const text = parts[cursor].text;
    const boundaries = scanShellText(text).boundaries.filter((boundary) => boundary.kind === 'group');
    const closes = boundaries.filter((boundary) => text[boundary.start] === ')').length + (/}\s*$/.test(text) ? 1 : 0);
    const opens =
      boundaries.filter((boundary) => text[boundary.start] === '(').length + (/^\s*\{(?:\s|$)/.test(text) ? 1 : 0);
    depth += closes - opens;
    if (opens > 0 && depth <= 0) {
      let start = cursor;
      while (start > 0 && ['|', '|&'].includes(parts[start].separator)) start--;
      return start;
    }
  }
  return index;
}
