import type { HumanDispositionReasonCode } from '@cat-cafe/shared';

export interface HumanDispositionReasonCopy {
  label: string;
  hint: string;
}

export const HUMAN_DISPOSITION_REASON_COPY = {
  not_important: {
    label: '不重要',
    hint: '这件事不值得继续处理或保留。',
  },
  wrong_lane: {
    label: '投错地方',
    hint: '内容可能有用，但不属于当前入口。',
  },
  bad_evidence: {
    label: '证据不对',
    hint: '依据不可靠、不完整，或无法支持这项建议。',
  },
  not_now: {
    label: '现在不处理',
    hint: '方向可能成立，但当前时机不合适。',
  },
  wrong: {
    label: '内容不对',
    hint: '建议本身不准确，不能按当前内容采纳。',
  },
  other: {
    label: '其他',
    hint: '用一句话告诉我们更合适的原因。',
  },
} satisfies Record<HumanDispositionReasonCode, HumanDispositionReasonCopy>;
