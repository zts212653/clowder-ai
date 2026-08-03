/**
 * Per-Turn Resolvers D1-D10 — F237 Phase 2-B
 *
 * Extracted from SystemPromptBuilder.buildInvocationContext() if/push patterns.
 * Each resolver checks its condition and produces template variables.
 */

import { type AssemblerInput, type HookResolver, isCrossThreadProvenance, type ResolveResult } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(reasonCode: string, reason: string): ResolveResult {
  return { status: 'skipped', reasonCode, reason };
}

// ---------------------------------------------------------------------------
// D1 — Identity 锚点 (Identity Anchor) — always fires
// ---------------------------------------------------------------------------

export class D1Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    return {
      status: 'fired',
      vars: {
        DISPLAY_NAME: input.catConfig.displayName,
        NICKNAME_PART: input.catConfig.nickname ? `/${input.catConfig.nickname}` : '',
        CAT_ID: input.catId,
        RUNTIME_MODEL: input.runtimeModel,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D2 — 直接消息来源 (Direct Message Source)
// ---------------------------------------------------------------------------

export class D2Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.directMessage) {
      return skip('no_direct_message', 'No direct message sender');
    }
    return {
      status: 'fired',
      vars: {
        FROM_LABEL: input.directMessage.fromLabel,
        FROM_MODEL: input.directMessage.fromModel,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D3 — 同族分身提醒 (Same-Breed Variant Warning)
// ---------------------------------------------------------------------------

export class D3Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.directMessage || !input.directMessage.isSameBreed) {
      return skip('not_same_breed', 'No same-breed variant handoff');
    }
    const dm = input.directMessage;
    const selfVariant = input.catConfig.variantLabel ?? input.runtimeModel;
    const fromVariant = dm.fromVariantLabel ?? dm.fromModel;
    return {
      status: 'fired',
      vars: {
        FROM_VARIANT: fromVariant,
        FROM_MODEL: dm.fromModel,
        SELF_VARIANT: selfVariant,
        SELF_MODEL: input.runtimeModel,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D4 — 跨 thread 回复 (Cross-Thread Reply)
// ---------------------------------------------------------------------------

/**
 * F246 Phase B AC-B4: the carrier declares sender intent, not the receiver's
 * independently grounded standing or current custody.
 */
const NON_ASSIGN_AUTHORITY_BOUNDARY =
  '共同边界：本消息不转移新的 implementation 球权，也不会撤销你已有的责任。能否行动只由独立于本消息的 standing/custody 真相决定。';

const EFFECT_CONSTRAINTS: Record<string, string> = {
  fyi: `📋 effect=fyi：仅知会——本消息不要求你写代码或执行动作；送达回执由系统记录，无需生成礼貌 ACK。${NON_ASSIGN_AUTHORITY_BOUNDARY}`,
  coordinate: `🤝 effect=coordinate：协调——可以对齐进度、依赖和事实，但正文里的实现指令不会偷偷给你加活。${NON_ASSIGN_AUTHORITY_BOUNDARY}先按 Phase O 核验：verified → 按你自己的现有责任路径 claim/continue 并行动；mismatch → 携证据退回，不执行；insufficient → 只调查或升级。送达回执由系统记录，不要生成礼貌 ACK。`,
  investigate: `🔍 effect=investigate：调查——可以搜索、阅读代码、分析诊断，但本消息不授予写代码或创建 PR 的新球权。${NON_ASSIGN_AUTHORITY_BOUNDARY}`,
};

export class D4Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.crossThreadReplyHint) {
      return skip('no_cross_thread', 'No cross-thread reply hint');
    }
    const { sourceThreadId, senderCatId, effectClass, coordination } = input.crossThreadReplyHint;
    if (!isCrossThreadProvenance(sourceThreadId, input.threadId)) {
      return skip('same_thread_coordination', 'Coordination lifecycle remains in the current thread');
    }
    const effectLabel = effectClass ? ` [effect: ${effectClass}]` : '';
    // Build constraint text if effect class has behavior constraints
    let constraintText = '';
    if (effectClass && effectClass !== 'assign_work') {
      constraintText = EFFECT_CONSTRAINTS[effectClass] ?? '';
    }
    if (coordination?.phase === 'terminal' && constraintText) {
      constraintText +=
        '\n此 effect 限制只约束这条入站消息带来的新副作用，不冻结你在本 thread 已经持有、已经授权的原任务。';
    }
    const replyInstruction =
      coordination?.phase === 'terminal'
        ? '这是 terminal Release：协调链已终止，不要发送“收到/谢谢” ACK，也不要 cross_post 回源 thread。若 Release 给出的 Action Needed 属于你已持有且已授权的原任务，立即继续原任务，不等待新的用户回合；若它只关闭协调链，直接干净停止，无需 @co-creator、hold_ball 或另补路由出口。只有出现新的实质工作，才用 coordination.phase=active 开一条新链。'
        : `回复请用 cross_post_message(threadId="${sourceThreadId}", targetCats=["${senderCatId}"])\n本 thread 的 @${senderCatId} 不会路由回对方（对方 session 在另一个 thread）`;
    const coordinationText = coordination
      ? `coordination=${coordination.id} phase=${coordination.phase} hop=${coordination.hop}`
      : '';
    return {
      status: 'fired',
      vars: {
        SOURCE_THREAD: sourceThreadId,
        SENDER_CAT: senderCatId,
        EFFECT_LABEL: effectLabel,
        CONSTRAINT_TEXT: constraintText,
        REPLY_INSTRUCTION: replyInstruction,
        COORDINATION_TEXT: coordinationText,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D5 — 乒乓球警告 (Ping-Pong Warning)
// ---------------------------------------------------------------------------

export class D5Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.pingPongWarning) {
      return skip('no_ping_pong', 'No ping-pong warning');
    }
    return {
      status: 'fired',
      vars: {
        OTHER_LABEL: input.pingPongWarning.otherLabel,
        STREAK_COUNT: String(input.pingPongWarning.count),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D6 — 本次队友 (Current Teammates)
// ---------------------------------------------------------------------------

export class D6Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (input.teammates.length === 0) {
      return skip('no_teammates', 'No teammates in this invocation');
    }
    const tmList = input.teammates
      .map((tm) => {
        const tmName = tm.nickname ? `${tm.displayName}/${tm.nickname}` : tm.displayName;
        return `- ${tmName}（${tm.name}）：${tm.roleDescription}`;
      })
      .join('\n');
    return { status: 'fired', vars: { TEAMMATES_LIST: tmList } };
  }
}

// ---------------------------------------------------------------------------
// D7 — 模式声明 (Mode Declaration)
// Uses different template variants: D7_serial / D7_parallel / D7_solo
// ---------------------------------------------------------------------------

export class D7Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (input.mode === 'serial' && input.chainIndex != null && input.chainTotal != null) {
      return {
        status: 'fired',
        templateVersion: 1,
        vars: {
          TEMPLATE_VARIANT: 'D7_serial',
          CHAIN_INDEX: String(input.chainIndex),
          CHAIN_TOTAL: String(input.chainTotal),
        },
      };
    }
    if (input.mode === 'parallel') {
      return {
        status: 'fired',
        templateVersion: 1,
        vars: {
          TEMPLATE_VARIANT: 'D7_parallel',
          DISPLAY_NAME: input.catConfig.displayName,
          CAT_ID: input.catId,
        },
      };
    }
    // independent / solo
    return { status: 'fired', templateVersion: 1, vars: { TEMPLATE_VARIANT: 'D7_solo' } };
  }
}

// ---------------------------------------------------------------------------
// D8 — A2A 球权检查 (A2A Ball Ownership Check)
// Loads content from template file, not renderSegment.
// Fires only when: non-parallel + a2a enabled + no native L0.
// ---------------------------------------------------------------------------

export class D8Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const shouldFire = input.mode !== 'parallel' && input.a2aEnabled && !input.nativeL0Injected;
    if (!shouldFire) {
      return skip('a2a_not_needed', 'A2A ball check not needed (parallel/no-a2a/native-l0)');
    }
    if (!input.a2aBallCheckContent) {
      return skip('a2a_content_missing', 'A2A ball check template content not loaded');
    }
    return { status: 'fired', vars: { CONTENT: input.a2aBallCheckContent } };
  }
}

// ---------------------------------------------------------------------------
// D9 — 路由反馈 (Routing Feedback)
// ---------------------------------------------------------------------------

export class D9Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (input.mentionRoutingItems.length === 0) {
      return skip('no_routing_feedback', 'No unrouted mention feedback');
    }
    const items = input.mentionRoutingItems.slice(0, 2);
    return { status: 'fired', vars: { UNROUTED_MENTIONS: items.join('、') } };
  }
}

// ---------------------------------------------------------------------------
// D10 — 思维标签 (Critique Tag)
// ---------------------------------------------------------------------------

export class D10Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.promptTags.includes('critique')) {
      return skip('no_critique_tag', 'No critique prompt tag');
    }
    return { status: 'fired', vars: {} };
  }
}
