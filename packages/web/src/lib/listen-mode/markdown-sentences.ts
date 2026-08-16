import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { type Plugin, unified } from 'unified';

export interface ListenSourceFragment {
  start: number;
  end: number;
}

export interface ListenSentence {
  anchor: string;
  occurrence: number;
  index: number;
  text: string;
  normalizedText: string;
  sourceStart: number;
  sourceEnd: number;
  fragments: ListenSourceFragment[];
  container: 'heading' | 'paragraph' | 'listItem' | 'blockquote';
}

interface PositionedNode {
  type: string;
  value?: string;
  url?: string;
  children?: AnnotatableNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

interface AnnotatableNode extends PositionedNode {
  data?: {
    hName?: string;
    hProperties?: Record<string, string | number | boolean>;
  };
}

interface ReadableBuffer {
  text: string;
  sourceOffsets: Array<number | null>;
}

const parser = unified().use(remarkParse).use(remarkGfm);
const sentenceSegmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
const SKIPPED_NODE_TYPES = new Set([
  'code',
  'inlineCode',
  'math',
  'inlineMath',
  'image',
  'imageReference',
  'html',
  'yaml',
  'toml',
]);
const TABLE_NODE_TYPES = new Set(['table', 'tableRow', 'tableCell']);
const BARE_URL_RE = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

/**
 * Replace leading YAML frontmatter with spaces while preserving newlines and
 * source offsets. remark-frontmatter is intentionally not required by the web
 * bundle; masking keeps the parser from treating the fence/body as readable
 * Markdown without changing every later AST position.
 */
export function maskLeadingMarkdownFrontmatter(markdown: string): string {
  const match = markdown.match(/^(?:\uFEFF)?---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/);
  if (!match) return markdown;
  const masked = match[0].replace(/[^\r\n]/g, ' ');
  return masked + markdown.slice(match[0].length);
}

function normalizeSentenceText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？!?；;,.])/g, '$1')
    .trim();
}

function plainText(node: PositionedNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (SKIPPED_NODE_TYPES.has(node.type)) return '';
  return (node.children ?? []).map(plainText).join('');
}

function appendText(buffer: ReadableBuffer, value: string, start: number, end: number): void {
  const sourceLength = Math.max(0, end - start);
  for (let index = 0; index < value.length; index++) {
    buffer.text += value[index];
    buffer.sourceOffsets.push(start + Math.min(index, Math.max(0, sourceLength - 1)));
  }
}

function appendBoundarySpace(buffer: ReadableBuffer): void {
  if (!buffer.text || /\s$/.test(buffer.text)) return;
  buffer.text += ' ';
  buffer.sourceOffsets.push(null);
}

function isBareLink(node: PositionedNode): boolean {
  if (node.type !== 'link' && node.type !== 'linkReference') return false;
  const label = normalizeSentenceText(plainText(node));
  const url = node.url ?? '';
  return BARE_URL_RE.test(label) || Boolean(url && label === url);
}

function appendPositionedText(node: PositionedNode, markdown: string, buffer: ReadableBuffer): boolean {
  if (node.type !== 'text' || node.value == null) return false;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null) return true;

  const previousOffset = [...buffer.sourceOffsets].reverse().find((offset) => offset != null);
  if (previousOffset != null && /\s/.test(markdown.slice(previousOffset + 1, start))) appendBoundarySpace(buffer);
  appendText(buffer, node.value, start, end);
  return true;
}

function collectReadableText(node: PositionedNode, markdown: string, buffer: ReadableBuffer): void {
  if (SKIPPED_NODE_TYPES.has(node.type) || TABLE_NODE_TYPES.has(node.type)) return;
  if (isBareLink(node) || node.type === 'break') {
    appendBoundarySpace(buffer);
    return;
  }
  if (appendPositionedText(node, markdown, buffer)) return;
  for (const child of node.children ?? []) collectReadableText(child, markdown, buffer);
}

function fragmentsForRange(sourceOffsets: Array<number | null>, start: number, end: number): ListenSourceFragment[] {
  const fragments: ListenSourceFragment[] = [];
  let fragmentStart: number | null = null;
  let previousOffset: number | null = null;

  const flush = () => {
    if (fragmentStart == null || previousOffset == null) return;
    fragments.push({ start: fragmentStart, end: previousOffset + 1 });
    fragmentStart = null;
    previousOffset = null;
  };

  for (let index = start; index < end; index++) {
    const offset = sourceOffsets[index];
    if (offset == null) {
      flush();
      continue;
    }
    if (fragmentStart == null) {
      fragmentStart = offset;
      previousOffset = offset;
      continue;
    }
    if (previousOffset != null && offset === previousOffset + 1) {
      previousOffset = offset;
      continue;
    }
    flush();
    fragmentStart = offset;
    previousOffset = offset;
  }
  flush();
  return fragments;
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function semanticContainer(node: PositionedNode, ancestors: PositionedNode[]): ListenSentence['container'] | null {
  if (node.type === 'heading') return 'heading';
  if (node.type !== 'paragraph') return null;
  if (ancestors.some((ancestor) => TABLE_NODE_TYPES.has(ancestor.type))) return null;
  if (ancestors.some((ancestor) => ancestor.type === 'listItem')) return 'listItem';
  if (ancestors.some((ancestor) => ancestor.type === 'blockquote')) return 'blockquote';
  return 'paragraph';
}

function projectContainer(
  node: PositionedNode,
  ancestors: PositionedNode[],
  markdown: string,
  occurrences: Map<string, number>,
  sentences: ListenSentence[],
): void {
  const container = semanticContainer(node, ancestors);
  if (!container) return;

  const buffer: ReadableBuffer = { text: '', sourceOffsets: [] };
  collectReadableText(node, markdown, buffer);
  if (!normalizeSentenceText(buffer.text)) return;

  for (const segment of sentenceSegmenter.segment(buffer.text)) {
    const text = normalizeSentenceText(segment.segment);
    if (!text) continue;
    const fragments = fragmentsForRange(buffer.sourceOffsets, segment.index, segment.index + segment.segment.length);
    if (fragments.length === 0) continue;

    const normalizedText = text.normalize('NFKC');
    const occurrenceKey = `${container}\u0000${normalizedText}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const first = fragments[0];
    const last = fragments[fragments.length - 1];
    if (!first || !last) continue;

    sentences.push({
      anchor: `sentence-${stableHash(occurrenceKey)}-${occurrence}`,
      occurrence,
      index: sentences.length,
      text,
      normalizedText,
      sourceStart: first.start,
      sourceEnd: last.end,
      fragments,
      container,
    });
  }
}

/** Project rendered Markdown semantics into stable, clickable listen sentences. */
export function extractListenSentences(markdown: string): ListenSentence[] {
  const parseInput = maskLeadingMarkdownFrontmatter(markdown);
  const root = parser.parse(parseInput) as Root as PositionedNode;
  const sentences: ListenSentence[] = [];
  const occurrences = new Map<string, number>();

  const walk = (node: PositionedNode, ancestors: PositionedNode[]) => {
    if (node.type === 'heading' || node.type === 'paragraph') {
      projectContainer(node, ancestors, markdown, occurrences, sentences);
      return;
    }
    if (SKIPPED_NODE_TYPES.has(node.type) || TABLE_NODE_TYPES.has(node.type)) return;
    for (const child of node.children ?? []) walk(child, [...ancestors, node]);
  };

  walk(root, []);
  return sentences;
}

function sentenceForRange(sentences: ListenSentence[], start: number, end: number): ListenSentence | undefined {
  return sentences.find((sentence) =>
    sentence.fragments.some((fragment) => fragment.start <= start && fragment.end >= end),
  );
}

function splitBoundaries(sentences: ListenSentence[], sourceStart: number, sourceEnd: number): number[] {
  const boundaries = new Set([sourceStart, sourceEnd]);
  for (const sentence of sentences) {
    for (const fragment of sentence.fragments) {
      const start = Math.max(sourceStart, fragment.start);
      const end = Math.min(sourceEnd, fragment.end);
      if (start < end) {
        boundaries.add(start);
        boundaries.add(end);
      }
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function splitTextNode(node: AnnotatableNode, sentences: ListenSentence[]): AnnotatableNode[] {
  if (node.type !== 'text' || node.value == null) return [node];
  const sourceStart = node.position?.start.offset;
  const sourceEnd = node.position?.end.offset;
  if (sourceStart == null || sourceEnd == null) return [node];

  const points = splitBoundaries(sentences, sourceStart, sourceEnd);
  const result: AnnotatableNode[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (start == null || end == null || start === end) continue;
    const value = node.value.slice(start - sourceStart, end - sourceStart);
    if (!value) continue;
    const sentence = sentenceForRange(sentences, start, end);
    if (!sentence) {
      result.push({ type: 'text', value });
      continue;
    }
    result.push({
      type: 'listenSentence',
      children: [{ type: 'text', value }],
      data: {
        hName: 'span',
        hProperties: {
          'data-listen-sentence-anchor': sentence.anchor,
          'data-listen-sentence-index': sentence.index,
        },
      },
    });
  }
  return result.length > 0 ? result : [node];
}

function annotateListenSentenceNodes(node: AnnotatableNode, sentences: ListenSentence[]): void {
  if (!node.children || SKIPPED_NODE_TYPES.has(node.type) || TABLE_NODE_TYPES.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitTextNode(child, sentences);
    annotateListenSentenceNodes(child, sentences);
    return child;
  });
}

/** Annotate Markdown text leaves with sentence metadata without rewriting Markdown source. */
export function createListenSentenceRemarkPlugin(sentences: ListenSentence[]): Plugin<[], Root> {
  return () => (tree) => annotateListenSentenceNodes(tree as Root as AnnotatableNode, sentences);
}
