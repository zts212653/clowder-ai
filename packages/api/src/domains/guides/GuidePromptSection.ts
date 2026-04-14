/**
 * B-3: Guide Prompt Section — builds guide-related prompt lines for SystemPromptBuilder.
 *
 * Extracted from SystemPromptBuilder to keep guide protocol details out of the
 * generic prompt builder.  Returns `string[]` lines that the caller pushes
 * into the invocation-context block.
 */

import { loadGuideFlow } from './guide-registry-loader.js';

// ---------------------------------------------------------------------------
// Types (mirrors the guideCandidate shape on InvocationContext)
// ---------------------------------------------------------------------------

export interface GuidePromptInput {
  id: string;
  name: string;
  estimatedTime: string;
  status: 'offered' | 'awaiting_choice' | 'active' | 'completed';
  isNewOffer?: boolean;
  userSelection?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPreviewLines(id: string, name: string, threadId: string | undefined, status: string): string[] {
  let stepTips: string[] = [];
  try {
    const flow = loadGuideFlow(id);
    stepTips = flow.steps.map((s, i) => `${i + 1}. ${s.tips}`);
  } catch {
    stepTips = ['（步骤加载失败，请告知用户稍后再试）'];
  }

  const threadPart = threadId ? ` thread=${threadId}` : '';
  const previewSteps =
    status === 'offered'
      ? [
          `1. 调用 cat_cafe_update_guide_state(threadId="${threadId}", guideId="${id}", status="awaiting_choice")`,
          '2. 用以下步骤概览回复用户：',
          ...stepTips.map((t) => `   ${t}`),
          '3. 在最后问用户是否要开始引导',
        ]
      : [
          '1. 不要再次调用 cat_cafe_update_guide_state（当前已经是 awaiting_choice）',
          '2. 用以下步骤概览回复用户：',
          ...stepTips.map((t) => `   ${t}`),
          '3. 在最后问用户是否要开始引导',
        ];

  return [
    `🧭 Guide Selection:${threadPart} 用户选择了「步骤概览」 guideId=${id} name=${name}`,
    '你必须按以下步骤回复：',
    ...previewSteps,
    '',
  ];
}

function buildNewOfferLines(id: string, name: string, estimatedTime: string, threadId: string | undefined): string[] {
  const threadPart = threadId ? ` thread=${threadId}` : '';
  const blockJson = JSON.stringify({
    id: `guide-offer-${id}-${(threadId ?? '').slice(-8) || 'x'}`,
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title: `我找到了「${name}」引导流程（约 ${estimatedTime}）。要现在开始吗？`,
    options: [
      {
        id: 'start',
        label: '开始引导（推荐）',
        emoji: '🚀',
        action: { type: 'callback', endpoint: '/api/guide-actions/start', payload: { threadId, guideId: id } },
      },
      {
        id: 'preview',
        label: '先看步骤概览',
        emoji: '📋',
        action: { type: 'callback', endpoint: '/api/guide-actions/preview', payload: { threadId, guideId: id } },
      },
      {
        id: 'skip',
        label: '暂不需要',
        emoji: '⏭️',
        action: { type: 'callback', endpoint: '/api/guide-actions/cancel', payload: { threadId, guideId: id } },
      },
    ],
    messageTemplate: '引导流程：{selection}',
  });

  return [
    `🧭 Guide Matched:${threadPart} id=${id} name=${name} time=${estimatedTime}`,
    '你必须按以下步骤回复（严格遵守）：',
    '1. 写一句简短的话告知用户你找到了引导流程',
    '2. 调用 cat_cafe_create_rich_block，block 参数传入以下 JSON 字符串：',
    blockJson,
    `3. 调用 cat_cafe_update_guide_state(threadId="${threadId}", guideId="${id}", status="offered")（必须在 rich block 之后）`,
    '4. 禁止直接给出教程或步骤列表',
    '5. 禁止调用 cat_cafe_start_guide（等用户在选项卡中选择后再启动）',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build guide-related prompt lines for a single cat invocation.
 * Returns empty array when no guide injection is needed.
 */
export function buildGuidePromptLines(candidate: GuidePromptInput, threadId: string | undefined): string[] {
  const { id, name, estimatedTime, status, userSelection, isNewOffer } = candidate;
  const threadPart = threadId ? ` thread=${threadId}` : '';

  if ((status === 'offered' || status === 'awaiting_choice') && userSelection?.includes('步骤概览')) {
    return buildPreviewLines(id, name, threadId, status);
  }

  if (status === 'offered' && isNewOffer === true) {
    return buildNewOfferLines(id, name, estimatedTime, threadId);
  }

  if (status === 'offered' || status === 'awaiting_choice') {
    return [
      `🧭 Guide Pending:${threadPart} id=${id} name=${name} — 用户尚未选择`,
      '不要重复发送选项卡。用一句话提醒：「之前找到了引导流程，你要开始吗？」',
      '',
    ];
  }

  if (status === 'active') {
    return [
      `🧭 Guide Active:${threadPart} id=${id} name=${name}`,
      '引导进行中。回答与引导相关的问题，不要重发选项卡。用户要退出时调用 cat_cafe_guide_control(action="exit")。',
      '',
    ];
  }

  if (status === 'completed') {
    return [
      `🧭 Guide Completed:${threadPart} id=${id} name=${name}`,
      '用户刚完成了这个引导流程。用一句话肯定用户的操作（如"添加成员成功了"），并询问是否需要进一步帮助。不要重发选项卡。',
      '',
    ];
  }

  // cancelled: no injection needed
  return [];
}
