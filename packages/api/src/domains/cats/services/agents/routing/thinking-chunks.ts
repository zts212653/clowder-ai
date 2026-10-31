export const THINKING_CHUNK_SEPARATOR = '\n\n---\n\n';

export function renderThinkingChunks(chunks: readonly string[]): string {
  return chunks.join(THINKING_CHUNK_SEPARATOR);
}

export function appendThinkingChunk(chunks: readonly string[], next: string): string[] {
  if (!next) return [...chunks];
  if (chunks.length === 0) return [next];

  const last = chunks[chunks.length - 1];
  if (last === next) return [...chunks];
  if (next.startsWith(last)) return [...chunks.slice(0, -1), next];
  if (last.startsWith(next)) return [...chunks];
  return [...chunks, next];
}
