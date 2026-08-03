export interface ChunkResult {
  text: string;
  isBoost: boolean;
}

const HARD_BREAKS = new Set(['。', '？', '！', '.', '?', '!']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '；', ';']);

const BOOST_COUNT = 2;
const NORMAL_THRESHOLD = 4;
const BOOST_THRESHOLD = 2;
const MAX_CHUNK_CHARS = 500;
// Keeps cloned Qwen speech comfortably below mlx-audio's 1,200-codec-token
// default ceiling (~96 s) while amortizing per-request clone-model warmup.
const STATIC_SYNTHESIS_MAX_CHARS = 180;
const STATIC_SYNTHESIS_BREAKS = new Set([
  '。',
  '？',
  '！',
  '.',
  '?',
  '!',
  '，',
  ',',
  '、',
  '：',
  ':',
  '；',
  ';',
  '\n',
  ' ',
]);

export function chunkText(input: string): ChunkResult[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const chunks: ChunkResult[] = [];
  let buffer = '';
  let chunkIndex = 0;

  const flush = () => {
    const cleaned = buffer.trim();
    if (!cleaned) return;
    chunks.push({
      text: cleaned,
      isBoost: chunkIndex < BOOST_COUNT,
    });
    chunkIndex++;
    buffer = '';
  };

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === '\n') {
      flush();
      continue;
    }

    buffer += ch;

    if (buffer.length >= MAX_CHUNK_CHARS) {
      const lastSpace = buffer.lastIndexOf(' ');
      if (lastSpace > 0) {
        const overflow = buffer.slice(lastSpace + 1);
        buffer = buffer.slice(0, lastSpace);
        flush();
        buffer = overflow;
      } else {
        flush();
      }
    } else if (HARD_BREAKS.has(ch)) {
      flush();
    } else if (SOFT_BREAKS.has(ch)) {
      const threshold = chunkIndex < BOOST_COUNT ? BOOST_THRESHOLD : NORMAL_THRESHOLD;
      if (buffer.length >= threshold) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

/**
 * Split long, non-streaming TTS input into bounded provider requests while
 * preserving every input character. Unlike `chunkText`, this packs multiple
 * sentences into each chunk to avoid paying clone-model warmup per sentence.
 */
export function chunkStaticTtsText(input: string): string[] {
  if (!input) return [];

  const chars = Array.from(input);
  if (chars.length <= STATIC_SYNTHESIS_MAX_CHARS) return [input];

  const chunks: string[] = [];
  let start = 0;

  while (start < chars.length) {
    const hardEnd = Math.min(start + STATIC_SYNTHESIS_MAX_CHARS, chars.length);
    let end = hardEnd;

    if (hardEnd < chars.length) {
      const earliestPreferredBreak = start + Math.floor(STATIC_SYNTHESIS_MAX_CHARS / 2);
      for (let index = hardEnd - 1; index >= earliestPreferredBreak; index--) {
        if (STATIC_SYNTHESIS_BREAKS.has(chars[index])) {
          end = index + 1;
          break;
        }
      }
    }

    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }

  return chunks;
}
