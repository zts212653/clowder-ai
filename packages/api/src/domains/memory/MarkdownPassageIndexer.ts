const MARKDOWN_DOC_PASSAGE_PREFIX = 'md-';

export { MARKDOWN_DOC_PASSAGE_PREFIX };

export function isMarkdownSourcePath(sourcePath: string | undefined): boolean {
  return typeof sourcePath === 'string' && sourcePath.endsWith('.md');
}

export function isMarkdownSeparator(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return [/^-{3,}$/, /^\*{3,}$/, /^_{3,}$/].some((pattern) => pattern.test(compact));
}

export function buildMarkdownDocumentPassages(content: string): string[] {
  const body = stripYamlFrontmatter(content);
  const passages: string[] = [];
  let buffer: string[] = [];
  let activeFence: ActiveFence = null;

  const flush = () => {
    const text = buffer
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    buffer = [];
    if (!text) return;
    if (isMarkdownSeparator(text)) return;
    passages.push(text);
  };

  for (const line of body.split(/\r?\n/)) {
    const fence = nextFenceState(line, activeFence);
    activeFence = fence.activeFence;
    if (fence.consumed) {
      buffer.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (activeFence == null && !trimmed) {
      flush();
      continue;
    }
    if (activeFence == null && isMarkdownSeparator(trimmed)) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return passages;
}

type ActiveFence = { char: '`' | '~'; length: number } | null;

function nextFenceState(line: string, activeFence: ActiveFence): { activeFence: ActiveFence; consumed: boolean } {
  const fenceMatch = line.match(/^\s{0,3}([`~]{3,})/);
  if (!fenceMatch?.[1]) return { activeFence, consumed: false };

  const marker = fenceMatch[1];
  const suffix = line.slice(fenceMatch[0].length);
  const char = marker[0] as '`' | '~';
  const length = marker.length;
  if (activeFence == null) return { activeFence: { char, length }, consumed: true };
  if (activeFence.char === char && length >= activeFence.length && suffix.trim() === '') {
    return { activeFence: null, consumed: true };
  }
  return { activeFence, consumed: false };
}

export function stripYamlFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return content;

  const closingMatch = normalized.slice(4).match(/\n---[ \t]*(?:\n|$)/);
  if (!closingMatch?.index) return content;

  const yaml = normalized.slice(4, 4 + closingMatch.index);
  if (!looksLikeYamlFrontmatter(yaml)) return content;

  const end = 4 + closingMatch.index + closingMatch[0].length;
  return normalized.slice(end);
}

function looksLikeYamlFrontmatter(yaml: string): boolean {
  let pendingBlockKey = false;
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (pendingBlockKey && (/^\s+-\s+\S/.test(line) || /^\s+\S/.test(line))) {
      return true;
    }
    pendingBlockKey = false;

    const keyMatch = trimmed.match(/^[A-Za-z0-9_-]+:\s*(.*)$/);
    if (!keyMatch) continue;
    if (keyMatch[1]?.trim()) return true;
    pendingBlockKey = true;
  }
  return false;
}
