/**
 * Prompt Injection — Compiled Preview endpoint (F237)
 *
 * GET /api/prompt-injection/compiled-preview?catId=xxx
 * Returns injection content pieces for a given cat. Frontend assembles
 * them based on selected scenario (first-turn / subsequent / after-handoff).
 * Includes active pack blocks when packs are installed.
 *
 * Extracted from prompt-injection.ts to stay within the 350-line limit.
 */

import { join } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { resolveDefaultClaudeMcpServerPath } from '../domains/cats/services/agents/providers/ClaudeAgentService.js';
import { compileL0ViaSubprocess } from '../domains/cats/services/agents/providers/l0-compiler.js';
import { getTemplateRawContent, stripComments } from '../domains/cats/services/context/prompt-template-loader.js';
import {
  buildStaticIdentity,
  buildStaticIdentityPackOnly,
} from '../domains/cats/services/context/SystemPromptBuilder.js';
import { getActivePackBlocks } from '../domains/packs/getActivePackBlocks.js';
import { PackStore } from '../domains/packs/PackStore.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { resolveUserId } from '../utils/request-identity.js';

/** ClientIds whose AgentService.injectsL0Natively() returns true */
const NATIVE_L0_CLIENT_IDS = new Set(['anthropic', 'openai', 'opencode']);

export const promptInjectionPreviewRoutes: FastifyPluginAsync = async (app) => {
  const packStoreDir = join(findMonorepoRoot(), '.cat-cafe', 'packs');
  const packStore = new PackStore(packStoreDir);

  app.get<{ Querystring: { catId?: string } }>('/api/prompt-injection/compiled-preview', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { catId } = request.query;
    if (!catId) {
      reply.status(400);
      return { error: 'catId query parameter required' };
    }

    try {
      const allCats = toAllCatConfigs(loadCatConfig());
      const catConfig = allCats[catId];
      const mcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
      const mcpAvailable = (catConfig?.mcpSupport ?? false) && !!mcpServerPath;
      const packBlocks = await getActivePackBlocks(packStore);

      const compiled = buildStaticIdentity(catId as CatId, { mcpAvailable, packBlocks, annotateSegments: true });
      if (!compiled) {
        reply.status(404);
        return { error: `Cat "${catId}" not found or has no identity config` };
      }

      const isNativeL0 = NATIVE_L0_CLIENT_IDS.has(catConfig?.clientId ?? '');

      // For native-L0: show actual compiled L0 (includes L1-L7, identity, governance, etc.)
      // For non-native: show S-segment view from buildStaticIdentity
      let systemPromptContent = compiled;
      let nativePackContext = '';
      if (isNativeL0) {
        try {
          systemPromptContent = await compileL0ViaSubprocess({ catId });
          nativePackContext = buildStaticIdentityPackOnly(catId as CatId, { packBlocks });
        } catch (e) {
          const nativeL0CompileError = e instanceof Error ? e.message : String(e);
          reply.status(500);
          return {
            error: `Native L0 compilation failed: ${nativeL0CompileError}`,
            nativeL0CompileError,
            catId,
            isNativeL0,
            clientId: catConfig?.clientId ?? 'unknown',
          };
        }
      }

      // D-segments: load real template content with {{VAR}} placeholders visible
      // tpl() returns raw template stripped of HTML comments, or '' if not template-backed
      const tpl = (id: string, useOverride = false): string => {
        const raw = getTemplateRawContent(id, useOverride);
        return raw ? stripComments(raw) : '';
      };

      const dynamicContext = [
        '── [D1] Identity 锚点 ──',
        tpl('D1'),
        '',
        '── [D2] 直接消息来源（条件：A2A 直接消息）──',
        tpl('D2'),
        '',
        '── [D3] 同族分身提醒（条件：同族 handoff）──',
        tpl('D3'),
        '',
        '── [D4] 跨 thread 回复（条件：跨线程消息）──',
        tpl('D4'),
        '',
        '── [D5] 乒乓球警告（条件：连续互传 ≥2 轮）──',
        tpl('D5'),
        '',
        '── [D6] 本次队友 ──',
        tpl('D6'),
        '',
        '── [D7] 模式声明 ──',
        `[串行] ${tpl('D7_serial')}`,
        `[并行] ${tpl('D7_parallel')}`,
        `[独立] ${tpl('D7_solo')}`,
        '',
        '── [D8] A2A 球权检查（条件：A2A 非并行模式）──',
        tpl('D8'),
        '',
        '── [D9] 路由反馈（条件：上次 @ 未路由）──',
        tpl('D9'),
        '',
        '── [D10] 思维标签（条件：批判模式）──',
        tpl('D10'),
        '',
        '── [D11] Skill 触发（条件：Signal 触发）──',
        tpl('D11'),
        '',
        '── [D12] 活跃参与者 ──',
        tpl('D12'),
        '',
        '── [D13] 路由策略（条件：线程有路由策略）──',
        tpl('D13'),
        '',
        '── [D14] SOP 阶段提示（条件：有活跃工作流）──',
        tpl('D14'),
        '',
        '── [D15] Voice 模式 ──',
        `[ON] ${tpl('D15_on')}`,
        `[OFF] ${tpl('D15_off')}`,
        '',
        '── [D16] Bootcamp 模式（条件：训练营线程）──',
        tpl('D16'),
        '',
        '── [D17] Guide 候选（条件：匹配到引导）──',
        tpl('D17'),
        '',
        '── [D18] 世界上下文（条件：世界模式）──',
        tpl('D18'),
        '',
        '── [D19] Constitutional 知识（条件：always_on 文档）──',
        tpl('D19'),
        '',
        '── [D20] Signal 文章（条件：线程关联文章）──',
        tpl('D20'),
        '',
        '── [D21] 传球决策树（条件：A2A 非并行模式）──',
        tpl('D21'),
        '',
        '── [C1] MCP 回调指令（条件：非 Claude 客户端）──',
        tpl('C1', true),
        '',
        '── [N1] 导航上下文 ──',
        tpl('N1'),
      ].join('\n');

      // B-segments: session bootstrap with template-style placeholders
      const bootstrapContext = [
        '── [B1] Session Bootstrap ──',
        'Session #{{SESSION_NUMBER}}，已封存 {{SEALED_COUNT}} 个会话',
        '',
        '上一会话摘要：{{PREVIOUS_SESSION_SUMMARY}}',
        '线程记忆：{{THREAD_MEMORY}}',
        '活跃任务：{{ACTIVE_TASKS}}',
        '知识召回：{{KNOWLEDGE_RECALL}}',
        '记忆工具：search_evidence / read_session_events',
        '（上限 2000 token，超限按优先级裁剪）',
      ].join('\n');

      // User input placeholder
      const userInput = [
        '── [M1] 用户消息 ──',
        '{{USER_MESSAGE}}',
        '',
        '── [M2] 未读消息摘要（条件：有异步消息）──',
        '{{UNREAD_MESSAGES}}',
      ].join('\n');

      return {
        catId,
        systemPrompt: systemPromptContent,
        dynamicContext,
        bootstrapContext,
        userInput,
        nativePackContext,
        isNativeL0,
        clientId: catConfig?.clientId ?? 'unknown',
        staticLength: systemPromptContent.length,
        staticLines: systemPromptContent.split('\n').length,
        hasPackBlocks: !!packBlocks,
      };
    } catch (e) {
      reply.status(500);
      return { error: `Compilation failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
};
