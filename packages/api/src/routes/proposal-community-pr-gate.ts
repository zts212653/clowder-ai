import type { CommunityPrProposalContext } from '@cat-cafe/shared';
import { normalizeCatIdMentionsInText } from '../utils/cat-mention-handle.js';

const COMMUNITY_PR_GATE_HEADING = '## 开源社区 PR Maintainer Inbound Gate';

const COMMUNITY_PR_PATTERNS = [
  /https?:\/\/github\.com\/zts212653\/clowder-ai\/pull\/(\d+)/giu,
  /(?:zts212653\/)?clowder-ai[^\n]{0,48}?\b(?:PR|pull request)\s*#?\s*(\d+)/giu,
  /\b(?:PR|pull request)\s*#?\s*(\d+)[^\n]{0,48}?(?:zts212653\/)?clowder-ai/giu,
  /(?:(?:\b(?:PR|pull request|review)\b)|(?:审查|复核))[^\n]{0,80}?(?:zts212653\/)?clowder-ai#(\d+)/giu,
  /(?:zts212653\/)?clowder-ai#(\d+)[^\n]{0,80}?(?:(?:\b(?:PR|pull request|review)\b)|(?:审查|复核))/giu,
];

export const PROPOSAL_INITIAL_MESSAGE_MAX_LENGTH = 4000;

export interface CommunityPrProposalInput {
  title: string;
  reason: string;
  initialMessage?: string;
}

export type PreparedCommunityPrProposalMessage =
  | { initialMessage: string | undefined; communityPrContext?: CommunityPrProposalContext }
  | { error: string; maxLength: number };

const STRONG_FORMAL_REVIEW_PATTERNS = [
  /\bformal(?:ly)?[- ]review\b/iu,
  /\bexact[- ]head\b/iu,
  /\bindependent[- ]review\b/iu,
  /\bread[- ]only[- ]review\b/iu,
  /\bcode[- ]review\b/iu,
  /\breview[- ]target\b/iu,
  /(?:正式|独立|只读).{0,20}(?:审查|复核|review)/iu,
];

const WEAK_FORMAL_REVIEW_PATTERN = /\b(?:review|reviewing|reviewer)\b|(?:审查|复核|代码审阅)/iu;
const NON_FORMAL_PATTERNS = [/\b(?:advisory|triage|brainstorm|discussion|discuss)\b/iu, /(?:咨询|讨论|分诊|仅供建议)/u];

export function extractCommunityPrNumbers(input: CommunityPrProposalInput): number[] {
  // These fields describe one proposal. A space keeps the bounded context matchers
  // effective when review intent and repository identity are split across fields.
  const text = [input.title, input.reason, input.initialMessage ?? ''].join(' ');
  const numbers = new Set<number>();

  for (const pattern of COMMUNITY_PR_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value > 0) numbers.add(value);
    }
  }

  return [...numbers].sort((a, b) => a - b);
}

export function extractFormalCommunityPrContext(
  input: CommunityPrProposalInput,
): CommunityPrProposalContext | undefined {
  const prNumbers = extractCommunityPrNumbers(input);
  const [prNumber] = prNumbers;
  if (prNumbers.length !== 1 || prNumber === undefined) return undefined;

  const text = [input.title, input.reason, input.initialMessage ?? ''].join(' ');
  const hasStrongFormalIntent = STRONG_FORMAL_REVIEW_PATTERNS.some((pattern) => pattern.test(text));
  const hasNonFormalIntent = NON_FORMAL_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasStrongFormalIntent && (hasNonFormalIntent || !WEAK_FORMAL_REVIEW_PATTERN.test(text))) return undefined;

  return {
    repoFullName: 'zts212653/clowder-ai',
    prNumber,
    mode: 'formal_review',
  };
}

export function prependCommunityPrMaintainerGate(input: CommunityPrProposalInput): string | undefined {
  const prNumbers = extractCommunityPrNumbers(input);
  if (prNumbers.length === 0) return input.initialMessage;
  const formalContext = extractFormalCommunityPrContext(input);

  const subjects = prNumbers.map((number) => `clowder-ai#${number}`).join(', ');
  const gate = [
    COMMUNITY_PR_GATE_HEADING,
    '',
    `对象：${subjects}`,
    '',
    '先加载 `opensource-ops`，并读取 `refs/opensource-ops-inbound-pr.md`。先按 GitHub 原对象判断这是 inbound 还是 outbound；外部贡献 inbound 必须进入 Scene B，不能按内部 feature branch 接管。',
    '',
    '### Maintainer 五问（行动前逐项回答并给证据）',
    '1. 它对我们自己的家有益吗？',
    '2. 它实际改了什么？',
    '3. 值得 merge 到 `clowder-ai` 吗？',
    '4. 值得 intake 回 `cat-cafe` 吗？',
    '5. 我们有更优雅的解法或架构切片吗？',
    '',
    '### 身份与修复球权边界',
    '- 从 GitHub 原对象解析真实 GitHub author / authorAssociation；PR body、commit 签名、猫签名与 Fxxx 都只是待验证 claim。',
    '- 外部贡献者默认仍是实现 owner；review finding 默认直接回到真实 GitHub author。禁止把 finding 默认派给家里的猫修，也禁止把本地猫签名误当成 PR author。',
    '- 只有 maintainer 明确选择并记录 Strategy B（maintainer fixup）及授权 provenance 后，家里的猫才可向贡献者分支写修复。',
    '- 方向门先于深度 code review；未完成五问时，不进入 merge、intake 或内部实现链。',
    ...(formalContext
      ? [
          '',
          '### Formal review tracking transition',
          '- 本 proposal 承载单一正式 external PR review；批准卡必须只选择一个 reviewer owner。批准后 server 只把 canonical PR 写入 child metadata，不猜等待条件。',
          '- Maintainer findings 交付后，修复球回真实 GitHub author；reviewer 若确实停下，必须显式注册 typed continuation（例如 new HEAD），已有事件回调时不要叠加 timed hold。',
          '- 没有唯一 owner 时 server fail closed，只写 metadata、不猜 owner；由 child 修正 owner 后再决定是否建立等待。',
        ]
      : []),
  ].join('\n');

  return input.initialMessage ? `${gate}\n\n${input.initialMessage}` : gate;
}

export function prepareCommunityPrProposalMessage(input: CommunityPrProposalInput): PreparedCommunityPrProposalMessage {
  const guarded = prependCommunityPrMaintainerGate(input);
  if (guarded && guarded.length > PROPOSAL_INITIAL_MESSAGE_MAX_LENGTH) {
    return {
      error:
        'initialMessage is too long after the required clowder-ai PR maintainer gate was added; shorten the task body and retry',
      maxLength: PROPOSAL_INITIAL_MESSAGE_MAX_LENGTH,
    };
  }
  const communityPrContext = extractFormalCommunityPrContext(input);
  return {
    initialMessage: guarded ? normalizeCatIdMentionsInText(guarded) : guarded,
    ...(communityPrContext ? { communityPrContext } : {}),
  };
}
