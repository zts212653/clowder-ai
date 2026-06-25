/**
 * Session-Init Resolvers (S1-S13, B1, C1) — F237 Phase 2-B
 *
 * Extracted from SystemPromptBuilder.buildStaticIdentity() if/push patterns.
 * Each resolver checks its condition and produces template variables.
 * B1 (session bootstrap) and C1 (MCP callback) always fire.
 */

import type { AssemblerInput, HookResolver, ResolveResult } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(reasonCode: string, reason: string): ResolveResult {
  return { status: 'skipped', reasonCode, reason };
}

// ---------------------------------------------------------------------------
// S1 — 身份声明 (Identity Declaration) — always fires
// ---------------------------------------------------------------------------

export class S1Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const { catConfig: c, providerLabel } = input;
    const nameLabel = c.nickname ? `${c.displayName}/${c.nickname}（${c.name}）` : `${c.displayName}（${c.name}）`;
    const nicknameOrigin = c.nickname ? `昵称 "${c.nickname}" 的由来见 docs/stories/cat-names/。\n` : '';
    return {
      status: 'fired',
      vars: {
        NAME_LABEL: nameLabel,
        PROVIDER_LABEL: providerLabel,
        NICKNAME_ORIGIN: nicknameOrigin,
        ROLE_DESCRIPTION: c.roleDescription,
        PERSONALITY: c.personality,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// S2 — 硬限制 (Hard Restrictions)
// ---------------------------------------------------------------------------

export class S2Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const restrictions = input.catConfig.restrictions;
    if (!restrictions || restrictions.length === 0) {
      return skip('no_restrictions', 'No restrictions configured');
    }
    return { status: 'fired', vars: { RESTRICTIONS_TEXT: restrictions.join('、') } };
  }
}

// ---------------------------------------------------------------------------
// S3 — Pack Masks (能力覆盖)
// ---------------------------------------------------------------------------

export class S3Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.packMasksBlock) {
      return skip('no_pack_masks', 'No pack masks block available');
    }
    return { status: 'fired', vars: { PACK_MASKS_BLOCK: input.packMasksBlock } };
  }
}

// ---------------------------------------------------------------------------
// S4 — 协作格式 (Collaboration Format)
// ---------------------------------------------------------------------------

export class S4Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    const { mentions, hasDuplicateDisplayNames, uniqueHandleExample } = input.callableMentions;
    if (mentions.length === 0) {
      return skip('no_callable_mentions', 'No callable mentions available');
    }
    const exampleTarget = mentions[0]!;
    let dupHint = '';
    if (hasDuplicateDisplayNames) {
      const example = uniqueHandleExample ?? '@opus';
      dupHint = [
        `同族多分身时：默认 \`@显示名\`，其它用**唯一句柄**（例如 \`${example}\`）。`,
        `同名队友并存时，请优先使用唯一句柄（例如 \`${example}\`）避免歧义。`,
        '',
      ].join('\n');
    }
    return {
      status: 'fired',
      vars: {
        CALLABLE_MENTIONS: mentions.join(' / '),
        EXAMPLE_TARGET: exampleTarget,
        DUPLICATE_NAMES_HINT: dupHint,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// S5 — 队友名册 (Teammate Roster)
// ---------------------------------------------------------------------------

export class S5Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.rosterContent) {
      return skip('no_roster', 'No teammates in roster');
    }
    return { status: 'fired', vars: { ROSTER_CONTENT: input.rosterContent } };
  }
}

// ---------------------------------------------------------------------------
// S6 — 工作流触发点 (Workflow Triggers)
// ---------------------------------------------------------------------------

export class S6Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.workflowTriggerContent) {
      return skip('no_triggers', 'No workflow triggers for this breed');
    }
    // S6 uses raw content (no template vars), so pass as CONTENT
    return { status: 'fired', vars: { CONTENT: input.workflowTriggerContent } };
  }
}

// ---------------------------------------------------------------------------
// S7 — Pack Workflows
// ---------------------------------------------------------------------------

export class S7Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.packWorkflowsBlock) {
      return skip('no_pack_workflows', 'No pack workflows block');
    }
    return { status: 'fired', vars: { PACK_WORKFLOWS_BLOCK: input.packWorkflowsBlock } };
  }
}

// ---------------------------------------------------------------------------
// S8 — co-creator 引用 (Co-Creator Reference) — always fires
// ---------------------------------------------------------------------------

export class S8Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    return {
      status: 'fired',
      vars: { CC_NAME: input.coCreatorName, CC_HANDLES: input.coCreatorHandles },
    };
  }
}

// ---------------------------------------------------------------------------
// S9 — 治理摘要 (Governance Digest) — always fires
// ---------------------------------------------------------------------------

export class S9Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: { GOVERNANCE_DIGEST: input.governanceDigest } };
  }
}

// ---------------------------------------------------------------------------
// S10 — Pack Guardrails (护栏)
// ---------------------------------------------------------------------------

export class S10Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.packGuardrailBlock) {
      return skip('no_pack_guardrails', 'No pack guardrails block');
    }
    return { status: 'fired', vars: { PACK_GUARDRAILS_BLOCK: input.packGuardrailBlock } };
  }
}

// ---------------------------------------------------------------------------
// S11 — Pack Defaults (默认行为)
// ---------------------------------------------------------------------------

export class S11Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.packDefaultsBlock) {
      return skip('no_pack_defaults', 'No pack defaults block');
    }
    return { status: 'fired', vars: { PACK_DEFAULTS_BLOCK: input.packDefaultsBlock } };
  }
}

// ---------------------------------------------------------------------------
// S12 — World Driver (世界驱动)
// ---------------------------------------------------------------------------

export class S12Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.packWorldDriverSummary) {
      return skip('no_world_driver', 'No world driver summary');
    }
    return { status: 'fired', vars: { WORLD_DRIVER_SUMMARY: input.packWorldDriverSummary } };
  }
}

// ---------------------------------------------------------------------------
// S13 — MCP 工具文档
// ---------------------------------------------------------------------------

export class S13Resolver implements HookResolver {
  resolve(input: AssemblerInput): ResolveResult {
    if (!input.mcpAvailable) {
      return skip('mcp_not_available', 'MCP tools not available for this cat');
    }
    // S13 uses raw content (loaded from MCP tools section), not template vars
    return { status: 'fired', vars: { CONTENT: input.mcpToolsSection } };
  }
}

// ---------------------------------------------------------------------------
// B1 — 会话引导 (Session Bootstrap) — always fires
// ---------------------------------------------------------------------------

export class B1Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

// ---------------------------------------------------------------------------
// C1 — MCP 回调 (MCP Callback) — always fires
// ---------------------------------------------------------------------------

export class C1Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}
