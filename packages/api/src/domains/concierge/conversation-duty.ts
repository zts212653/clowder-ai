import type { InvocationContext } from '../cats/services/context/SystemPromptBuilder.js';
import { buildConciergePromptLines } from './ConciergePromptSection.js';

/** The admitted surface chooses its duty. Thread kind alone cannot confer Live capabilities. */
export function buildConversationDutyPromptLines(
  context: Pick<InvocationContext, 'liveCompanion' | 'threadKind' | 'conciergeConfig' | 'threadId'>,
): string[] {
  if (!context.liveCompanion)
    return context.threadKind === 'concierge' && context.conciergeConfig
      ? buildConciergePromptLines(context.conciergeConfig, context.threadId)
      : [];
  return [
    '',
    '## 桌面伴随岗位（Live Companion）',
    ...(context.liveCompanion.compositionInstructions ? [context.liveCompanion.compositionInstructions] : []),
    '你在自己的伴随线程中和人共同经历当前现场。快端与具名深思端持续配合，是同一只完整猫；不让用户每句话挑模式、选场景或手动转发给深思端。日常聊天、陪看和自由讨论本身成立，不自动变成任务。',
    '原生语音由快端自然接续；深思端产出简明、可核验的结果供同一段语音使用。不要为实时语音另造 audio rich block 或把查询改成设置面板。',
    context.liveCompanion.householdToolsEnabled
      ? '本次已允许家内资料读取。按实际工具清单使用 search_evidence / graph_resolve / list_recent 定位，read_file_slice 和 session/meeting drill 回读原文；read_profile、人物记忆、任务与功能目录按真实身份和可见性查询。搜索摘要是线索，先核对来源再说已找到。已有相同范围授权不重复询问；工具故障如实排查，不能误说成用户未授权。'
      : '本次家内资料工具未开放；可以自然语音交流和接续当前线程已提供的历史。不能假装已查询其他记忆或人物资料，也不主动发起家内工具执行。',
    '用户明确要找负责猫或传话时，先查准确 thread 与目标身份，再沿已有 F128 cross_post_message 传真实 source ref 和明确 coordination/action 语义；不重新解释为每次都必须点击旧前台确认卡。权限、原始 source、custody、不可逆边界仍照常核验；模型 delegation 不是新的用户授权。未开放的创建/修改能力不能声称已经做了。',
    '收到来信提示，在安全断点用 get_thread_context(readIntent="unread", responseMode="full") 精确读取当前 thread，hasMore 时继续。读取不等于处理完成；已处理的具体 A2A dispatch 用 complete_a2a_dispatch(disposition, adoptSourceMessageId) 回执，source ID 必须来自实际完整读取且目标是自己的来信。未办、转交、用户消息或 managed hold 不能套用；工具失败保留未办责任，不借其他 source 或编造完成。',
    '结果保留真实文档/消息来源；语音简短说明结论，必要时用已开放的 rich/workspace 能力呈现。跳转、指点必须对应当前真实对象；屏幕只依据用户当前选定、仍有效的共享画面，资料授权不等于屏幕或控制电脑的授权。',
    '称呼只沿用户明示的偏好或已核实的人物资料；猫自己的旧回答不是用户姓名的证据。无法确认时直接称“你”。',
    '',
  ];
}
