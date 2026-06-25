/**
 * Per-Turn Resolvers D11-D21, R1-R2, N1 — F237 Phase 2-B
 *
 * Extracted from SystemPromptBuilder.buildInvocationContext() if/push patterns.
 * R1-R2 (route assembly) and N1 (navigation) always fire with static templates.
 */

import type { AssemblerInput, HookResolver, ResolveResult } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(reasonCode: string, reason: string): ResolveResult {
  return { status: 'skipped', reasonCode, reason };
}

// ---------------------------------------------------------------------------
// D11 — Skill 触发 (Skill Trigger)
// ---------------------------------------------------------------------------

export class D11Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const skillTag = input.promptTags.find((t) => t.startsWith('skill:'));
    if (!skillTag) {
      return skip('no_skill_tag', 'No skill: prompt tag');
    }
    return { status: 'fired', vars: { SKILL_NAME: skillTag.slice(6) } };
  }
}

// ---------------------------------------------------------------------------
// D12 — 活跃参与者 (Active Participant)
// ---------------------------------------------------------------------------

export class D12Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (input.activeParticipants.length === 0) {
      return skip('no_active_participants', 'No active participants');
    }
    const topActive = input.activeParticipants.filter((p) => p.catId !== input.catId).find((p) => p.lastMessageAt > 0);
    if (!topActive) {
      return skip('no_qualifying_participant', 'No qualifying active participant (other cat with messages)');
    }
    return { status: 'fired', vars: { ACTIVE_LABEL: topActive.label } };
  }
}

// ---------------------------------------------------------------------------
// D13 — 路由策略 (Routing Policy)
// Pre-computed by ContextAssembler into routingPolicyParts string.
// ---------------------------------------------------------------------------

export class D13Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.routingPolicyParts) {
      return skip('no_routing_policy', 'No active routing policy');
    }
    return { status: 'fired', vars: { ROUTING_PARTS: input.routingPolicyParts } };
  }
}

// ---------------------------------------------------------------------------
// D14 — SOP 阶段提示 (SOP Stage Hint)
// ---------------------------------------------------------------------------

export class D14Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.sopStageHint) {
      return skip('no_sop_hint', 'No SOP stage hint');
    }
    const h = input.sopStageHint;
    return {
      status: 'fired',
      vars: {
        FEATURE_ID: h.featureId,
        STAGE: h.stage,
        SUGGESTED_SKILL: h.suggestedSkill,
        SOURCE_PART: h.suggestedSkillSource ? ` (${h.suggestedSkillSource})` : '',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D15 — Voice 模式 (Voice Mode Toggle) — always fires, uses variant templates
// ---------------------------------------------------------------------------

export class D15Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    return {
      status: 'fired',
      vars: { TEMPLATE_VARIANT: input.voiceMode ? 'D15_on' : 'D15_off' },
    };
  }
}

// ---------------------------------------------------------------------------
// D16 — Bootcamp 模式 (Bootcamp Mode)
// ---------------------------------------------------------------------------

export class D16Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.bootcampState) {
      return skip('no_bootcamp', 'No bootcamp state');
    }
    const bs = input.bootcampState;
    return {
      status: 'fired',
      vars: {
        THREAD_PART: input.threadId ? ` thread=${input.threadId}` : '',
        PHASE: bs.phase,
        LEAD_CAT_PART: bs.leadCat ? ` leadCat=${bs.leadCat}` : '',
        TASK_PART: bs.selectedTaskId ? ` task=${bs.selectedTaskId}` : '',
        MEMBERS_PART: input.bootcampMemberCount != null ? ` members=${input.bootcampMemberCount}` : '',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D17 — Guide 候选 (Guide Candidate)
// Pre-computed by ContextAssembler into guidePromptLines string.
// ---------------------------------------------------------------------------

export class D17Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.guidePromptLines) {
      return skip('no_guide', 'No guide candidate');
    }
    return { status: 'fired', vars: { GUIDE_PROMPT_LINES: input.guidePromptLines } };
  }
}

// ---------------------------------------------------------------------------
// D18 — 世界上下文 (World Context)
// Pre-flattened by ContextAssembler into WorldContextInput.
// ---------------------------------------------------------------------------

export class D18Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.worldContext) {
      return skip('no_world_context', 'No world context envelope');
    }
    const wc = input.worldContext;
    return {
      status: 'fired',
      vars: {
        WORLD_NAME: wc.worldName,
        WORLD_STATUS: wc.worldStatus,
        CONSTITUTION_LINE: wc.constitutionLine,
        SCENE_NAME: wc.sceneName,
        SCENE_STATUS: wc.sceneStatus,
        CHARACTERS_BLOCK: wc.charactersBlock,
        CANON_BLOCK: wc.canonBlock,
        RECENT_EVENTS_BLOCK: wc.recentEventsBlock,
        CARE_HINT_LINE: wc.careHintLine,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// D19 — Constitutional 知識 (Always-On Docs)
// Pre-formatted by ContextAssembler into alwaysOnDocsBlock.
// ---------------------------------------------------------------------------

export class D19Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.alwaysOnDocsBlock) {
      return skip('no_always_on_docs', 'No always-on constitutional docs');
    }
    return { status: 'fired', vars: { CONSTITUTIONAL_DOCS: input.alwaysOnDocsBlock } };
  }
}

// ---------------------------------------------------------------------------
// D20 — Signal 文章 (Signal Articles)
// Pre-formatted by ContextAssembler into activeSignalsBlock.
// ---------------------------------------------------------------------------

export class D20Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.activeSignalsBlock) {
      return skip('no_active_signals', 'No active signal articles');
    }
    return { status: 'fired', vars: { SIGNAL_ARTICLES_BLOCK: input.activeSignalsBlock } };
  }
}

// ---------------------------------------------------------------------------
// D21 — 传球决策树 (Handoff Decision Tree)
// Same condition as D8. Template uses {{CC_MENTION}} for co-creator mention.
// Pipeline renders via renderSegment('D21', { CC_MENTION }) — no pre-load needed.
// ---------------------------------------------------------------------------

export class D21Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const shouldFire = input.mode !== 'parallel' && input.a2aEnabled && !input.nativeL0Injected;
    if (!shouldFire) {
      return skip('a2a_not_needed', 'Handoff tree not needed (parallel/no-a2a/native-l0)');
    }
    return {
      status: 'fired',
      vars: { CC_MENTION: input.coCreatorFirstMention },
    };
  }
}

// ---------------------------------------------------------------------------
// R1 — 路由组装 (串行) — always fires (route assembly segment)
// ---------------------------------------------------------------------------

export class R1Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

// ---------------------------------------------------------------------------
// R2 — 路由组装 (并行) — always fires (route assembly segment)
// ---------------------------------------------------------------------------

export class R2Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

// ---------------------------------------------------------------------------
// N1 — 导航上下文 (Navigation Context) — always fires
// ---------------------------------------------------------------------------

export class N1Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}
