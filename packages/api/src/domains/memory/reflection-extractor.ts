import type {
  ExtractedReflectionDelta,
  ExtractReflectionInput,
  ReflectionOutputKind,
  ReflectionTranscriptEntry,
} from './reflection-types.js';

export const DEFAULT_REFLECTION_CANDIDATE_BUDGET = 5;

const MAX_CLAIM_LENGTH = 240;
const MAX_DELTAS_PER_SESSION = DEFAULT_REFLECTION_CANDIDATE_BUDGET;
const MIN_CLAIM_LENGTH = 6;

interface ReflectionSignal {
  kind: ReflectionOutputKind;
  roles: ReadonlySet<ReflectionTranscriptEntry['role']>;
  pattern: RegExp;
  excludePattern?: RegExp;
  reason: string;
}

const SIGNALS: ReadonlyArray<ReflectionSignal> = [
  {
    kind: 'correction',
    roles: new Set(['user']),
    pattern: /不同意|不想要|不直接|不应该|不该|不能|不是这样|别再|禁止|才对|我不理解|自相矛盾/,
    reason: 'The owner explicitly corrected a behavior or contract.',
  },
  {
    kind: 'decision',
    roles: new Set(['user', 'assistant']),
    pattern: /我同意|同意(?:呀|了|这个)?|决定|确定(?:了)?|选择|采用|拍板|定了|批准/,
    excludePattern: /(?:不|没|未|尚未)[^。！？?!]{0,4}(?:同意|决定|确定|选择|采用|拍板|批准)/,
    reason: 'The utterance explicitly records agreement or a selected course.',
  },
  {
    kind: 'identity_relationship',
    roles: new Set(['user']),
    pattern: /以后(?:请)?叫我|称呼(?:改成|更新为)|我们(?:已经|现在)是(?:伴侣|家人|未婚)|关系(?:变成|更新为)/,
    reason: 'The owner explicitly changed a stable identity or relationship fact.',
  },
  {
    kind: 'open_loop',
    roles: new Set(['user', 'assistant']),
    pattern:
      /如何(?:开始|继续|完成)|怎么(?:开始|继续|完成)|哪些[^。！？?!]{0,32}(?:没做|未做)|下一步|待(?:确认|完成|验证)|还没|未完成|依赖|打算如何|需要[^。！？?!]{0,40}推动/,
    reason: 'The utterance names a concrete unresolved dependency or next result.',
  },
  {
    kind: 'desire_cue',
    roles: new Set(['user', 'assistant']),
    pattern: /想要|我惦记|一直惦记|期待(?:你们|猫|我).{0,24}开口|很想(?:拥有|试试|看看)/,
    excludePattern: /(?:不|没|未|并不|不再|不是)[^。！？?!]{0,6}(?:想要|很想(?:拥有|试试|看看))/,
    reason: 'The utterance contains a desire worth revisiting in the cat private loop.',
  },
];

export function extractReflectionDeltas(input: ExtractReflectionInput): ExtractedReflectionDelta[] {
  const outputs: ExtractedReflectionDelta[] = [];
  const seen = new Set<string>();

  for (const entry of input.entries) {
    for (const output of extractEntryDeltas(input.catId, entry, seen)) {
      outputs.push(output);
      if (outputs.length >= MAX_DELTAS_PER_SESSION) return outputs;
    }
  }

  return outputs;
}

function extractEntryDeltas(
  catId: string,
  entry: ReflectionTranscriptEntry,
  seen: Set<string>,
): ExtractedReflectionDelta[] {
  if (!hasUsableSource(entry) || isNonConversationEnvelope(entry)) return [];
  const segments = splitClaims(entry.content);
  return SIGNALS.flatMap((signal) => {
    if (!signal.roles.has(entry.role)) return [];
    const claim = segments.find((segment) => signal.pattern.test(segment) && !signal.excludePattern?.test(segment));
    if (!claim) return [];
    const normalizedClaim = normalizeClaim(claim);
    const key = `${signal.kind}\0${normalizedClaim}`;
    if (normalizedClaim.length < MIN_CLAIM_LENGTH || seen.has(key)) return [];
    seen.add(key);
    return [toDelta(catId, entry, signal, normalizedClaim)];
  });
}

function toDelta(
  catId: string,
  entry: ReflectionTranscriptEntry,
  signal: (typeof SIGNALS)[number],
  normalizedClaim: string,
): ExtractedReflectionDelta {
  return {
    kind: signal.kind,
    destination: signal.kind === 'desire_cue' ? 'f255_private_cue' : 'public_evidence',
    normalizedClaim,
    reason: signal.reason,
    sourceRef: { ...entry.sourceRef },
    ...(signal.kind === 'desire_cue' ? { targetCatId: catId } : {}),
  };
}

function hasUsableSource(entry: ReflectionTranscriptEntry): boolean {
  const source = entry.sourceRef;
  if (!source.threadId.trim()) return false;
  if (source.messageId?.trim()) return true;
  return Boolean(source.sessionId?.trim() && Number.isInteger(source.eventNo) && (source.eventNo ?? -1) >= 0);
}

function isNonConversationEnvelope(entry: ReflectionTranscriptEntry): boolean {
  if (entry.role === 'system') return true;
  const trimmed = entry.content.trimStart();
  return (
    trimmed.startsWith('[tool') ||
    trimmed.startsWith('<tool') ||
    trimmed.startsWith('{"tool_') ||
    trimmed.includes('tool_result (completed)')
  );
}

function splitClaims(content: string): string[] {
  return content
    .split(/[。！？?!\n]+/u)
    .map(normalizeClaim)
    .filter((claim) => claim.length >= MIN_CLAIM_LENGTH);
}

export function normalizeReflectionClaim(claim: string): string {
  return normalizeClaim(claim);
}

function normalizeClaim(claim: string): string {
  return claim
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s#>*_-]+/u, '')
    .replace(/[\s,，;；:：]+$/u, '')
    .trim()
    .slice(0, MAX_CLAIM_LENGTH);
}
