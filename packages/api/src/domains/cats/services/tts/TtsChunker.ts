export interface ChunkResult {
  text: string;
  isBoost: boolean;
}

const HARD_BREAKS = new Set(['。', '？', '！', '.', '?', '!']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '；', ';']);

const BOOST_COUNT = 2;
const NORMAL_THRESHOLD = 4;
const BOOST_THRESHOLD = 2;

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

    if (HARD_BREAKS.has(ch)) {
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
