/** Deterministic lexical noise backed by regression fixtures, not lane classification. */
export const COMMON_CANDIDATE_PHRASES: ReadonlySet<string> = new Set([
  '公司',
  '项目',
  '昨天',
  '今天',
  '明天',
  '代码',
  '测试',
  '功能',
  'app',
  'commit',
  '我希',
  '我希望',
  '而言',
  '成本',
  '会议',
]);

const CJK_STOPWORDS: ReadonlySet<string> = new Set([
  '我们',
  '他们',
  '你们',
  '她们',
  '它们',
  '大家',
  '自己',
  '这个',
  '那个',
  '这些',
  '那些',
  '这样',
  '那样',
  '这里',
  '那里',
  '然后',
  '因为',
  '所以',
  '但是',
  '虽然',
  '而且',
  '或者',
  '以及',
  '不过',
  '因此',
  '另外',
  '同时',
  '于是',
  '已经',
  '可能',
  '应该',
  '非常',
  '比较',
  '一定',
  '一直',
  '总是',
  '经常',
  '马上',
  '立刻',
  '终于',
  '其实',
  '果然',
  '居然',
  '依然',
  '仍然',
  '可以',
  '需要',
  '知道',
  '觉得',
  '认为',
  '希望',
  '喜欢',
  '开始',
  '继续',
  '使用',
  '什么',
  '怎么',
  '如果',
  '关于',
  '没有',
  '不是',
  '就是',
  '现在',
  '时候',
  '问题',
  '情况',
  '方面',
  '一些',
  '一个',
  '一下',
  '一点',
  '好的',
  '对的',
  '嗯嗯',
  '哈哈',
  '呵呵',
  '哈哈哈',
  '笑死',
  '笑了',
  '笑哭',
  '绝了',
  '服了',
  '无语',
  '天哪',
  '我靠',
  '卧槽',
  '离谱',
  '真的',
  '太好了',
]);

const CJK_CHAR = /[一-鿿㐀-䶿\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEA1}]/u;
const CANDIDATE_BOUNDARY = /[，。！？、；：「」【】（）《》""''…—～·.,:;!?()\s]/;
const MIN_PHRASE_LENGTH = 2;
const MAX_PHRASE_LENGTH = 6;

const INTERJECTION_PATTERNS: readonly RegExp[] = [/^(.)\1+$/u, /^(..)\1+$/u, /^笑[死了哭]/u];

export interface CandidateExtractionResult {
  readonly phrases: readonly string[];
  readonly completeSegments: ReadonlySet<string>;
}

export function normalizeCandidatePhrase(phrase: string): string {
  return phrase.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isLexicalNoise(phrase: string): boolean {
  const normalized = normalizeCandidatePhrase(phrase);
  if (CJK_STOPWORDS.has(normalized) || COMMON_CANDIDATE_PHRASES.has(normalized)) return true;
  const length = [...normalized].length;
  return (
    length >= MIN_PHRASE_LENGTH &&
    length <= MAX_PHRASE_LENGTH &&
    INTERJECTION_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function collectCjkSegment(segment: string, phrases: string[], completeSegments: Set<string>): void {
  const chars = [...segment];
  if (chars.length <= MAX_PHRASE_LENGTH && !isLexicalNoise(segment)) {
    completeSegments.add(segment);
  }
  for (let length = MIN_PHRASE_LENGTH; length <= MAX_PHRASE_LENGTH; length += 1) {
    for (let start = 0; start <= chars.length - length; start += 1) {
      const phrase = chars.slice(start, start + length).join('');
      if (!isLexicalNoise(phrase)) phrases.push(phrase);
    }
  }
}

function collectLatinSegment(segment: string, phrases: string[], completeSegments: Set<string>): void {
  if ([...segment].length > MAX_PHRASE_LENGTH || isLexicalNoise(segment)) return;
  phrases.push(segment);
  completeSegments.add(segment);
}

/** Extract 2–6 character/token candidates without assigning a semantic lane. */
export function extractCandidatePhrases(text: string): CandidateExtractionResult {
  const phrases: string[] = [];
  const completeSegments = new Set<string>();
  const segments = text
    .normalize('NFKC')
    .split(CANDIDATE_BOUNDARY)
    .filter((segment) => [...segment].length >= MIN_PHRASE_LENGTH);

  for (const segment of segments) {
    if (CJK_CHAR.test(segment)) {
      collectCjkSegment(segment, phrases, completeSegments);
      continue;
    }
    collectLatinSegment(segment, phrases, completeSegments);
  }

  return { phrases, completeSegments };
}
