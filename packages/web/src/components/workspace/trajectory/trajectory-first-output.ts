import {
  type InvocationTrajectorySummary,
  type OutputMessageChannel,
  readOutputMessageChannel,
  readOutputMessageIdentity,
} from '@cat-cafe/shared';

export type FirstAssistantPreview =
  | { kind: 'sentence'; content: string; channel: OutputMessageChannel }
  | { kind: 'boundary_unconfirmed'; content: string; label: '首句边界未确认'; channel: OutputMessageChannel }
  | { kind: 'unavailable'; label: string };

const UNAVAILABLE_LABELS = {
  unknown_identity: '首条输出身份无法核验',
  unknown_channel: '首条输出通道无法核验',
  incomplete: '首条输出尚未完整',
  conflict: '首条输出记录有冲突',
  oversized: '首条输出超出预览上限，请查看原始记录',
} as const;

function hasUnconfirmedBoundary(candidate: string): boolean {
  // Segmentation proposes a boundary; native completion does not prove sentence
  // intent. Keep structural/identifier candidates visible without lexical guesses.
  if (/^(?:#{1,6}\s|>\s|[-*+]\s)/u.test(candidate)) return true;
  if (!/[。！？!?.]["'”’»）)\]}]*$/u.test(candidate)) return true;
  if (!/\.["'”’»）)\]}*]*$/u.test(candidate)) return false;
  const atoms = candidate.match(/[\p{L}\p{N}]+/gu) ?? [];
  const last = atoms.at(-1) ?? '';
  if (atoms.length < 2 && /^[A-Za-z]+$/u.test(last)) return true;
  // An open label and an ordinary verb followed by the same marker have the
  // same evidence. Neither vocabulary membership nor part of speech is authority.
  if (/^[A-Za-z\p{Nd}]+$/u.test(last) && (/\p{Nd}/u.test(last) || last.length === 1)) return true;
  if (last && /^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu.test(last)) return true;
  // Names/abbreviations at an ASCII period can also be continuation prefixes.
  return /^[A-Z][A-Za-z]*$/u.test(last) || /(?:[A-Za-z]+\.){2,}["'”’»）)\]}]*$/u.test(candidate);
}

function firstNativeCandidate(content: string): string | undefined {
  const first = new Intl.Segmenter('zh', { granularity: 'sentence' })
    .segment(content.trimStart())
    [Symbol.iterator]()
    .next().value;
  const candidate = first?.segment.trimEnd();
  return candidate && /[\p{L}\p{N}]/u.test(candidate) ? candidate : undefined;
}

export function firstAssistantPreview(summary: InvocationTrajectorySummary): FirstAssistantPreview {
  const evidence = summary.firstAssistantOutputEvidence;
  const unavailable = (label: string): FirstAssistantPreview => ({ kind: 'unavailable', label });
  if (!evidence) return unavailable('尚无可核验的首条输出');
  if (
    evidence.role !== 'assistant' ||
    evidence.source?.sessionId !== summary.sessionId ||
    evidence.source?.invocationId !== summary.invocationId
  )
    return unavailable('首条输出归属无法核验');
  if (evidence.status !== 'available') return unavailable(UNAVAILABLE_LABELS[evidence.status]);
  const channel = readOutputMessageChannel(evidence.channel);
  if (
    evidence.complete !== true ||
    typeof evidence.content !== 'string' ||
    !readOutputMessageIdentity(evidence.identity) ||
    !channel
  ) {
    return unavailable('首条输出证据不完整');
  }
  // Sentence boundaries operate inside this one proven native message. Never search later messages.
  const content = firstNativeCandidate(evidence.content);
  if (content === undefined) return unavailable('首条输出尚无可展示的候选');
  if (hasUnconfirmedBoundary(content)) {
    return { kind: 'boundary_unconfirmed', content, label: '首句边界未确认', channel };
  }
  return { kind: 'sentence', content, channel };
}
