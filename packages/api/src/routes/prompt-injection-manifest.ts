/**
 * Prompt Injection Manifest Route — F237 Phase 2
 *
 * GET /api/prompt-injection/manifest — aggregate 45 active hook.yaml manifests
 * into the ManifestSegment[] shape the Console frontend expects.
 *
 * Replaces the old monolithic assets/prompt-injection-manifest.yaml
 * with live scanning via HookRegistry.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookManifest } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getTemplateFileInfo } from '../domains/cats/services/context/prompt-template-loader.js';
import { HookRegistry } from '../domains/prompt-hooks/HookRegistry.js';
import { resolveUserId } from '../utils/request-identity.js';

// ---------------------------------------------------------------------------
// Project root resolution (same pattern as other routes)
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Prefix → category / consumer mapping
// ---------------------------------------------------------------------------

interface CategoryInfo {
  category: string;
  consumer: string;
  sourceType: string;
}

const PREFIX_MAP: Record<string, CategoryInfo> = {
  L: { category: 'l0-native', consumer: 'l0-compiler', sourceType: 'template' },
  S: { category: 'system-prompt', consumer: 'system-prompt-builder', sourceType: 'template' },
  D: { category: 'dynamic-per-turn', consumer: 'turn-context-builder', sourceType: 'template' },
  R: { category: 'route-assembly', consumer: 'route-assembler', sourceType: 'template' },
  B: { category: 'bootcamp', consumer: 'bootcamp-hook', sourceType: 'template' },
  C: { category: 'callback', consumer: 'mcp-callback', sourceType: 'template' },
  N: { category: 'navigation', consumer: 'navigation-builder', sourceType: 'template' },
};

function getCategoryInfo(id: string): CategoryInfo {
  const prefix = id.replace(/\d+$/, '');
  return PREFIX_MAP[prefix] ?? { category: 'unknown', consumer: 'unknown', sourceType: 'template' };
}

// ---------------------------------------------------------------------------
// HookManifest → ManifestSegment mapping
// ---------------------------------------------------------------------------

interface ManifestSegment {
  id: string;
  name: string;
  category: string;
  lifecycleStage: string;
  source: string;
  sourceType: string;
  trigger: string;
  purpose: string;
  userExplanation: string;
  priority: string;
  safetyTier: string;
  transparencyTier: string;
  governanceTier: string;
  allowLocalOverride: boolean;
  disableable: boolean;
  consumer: string;
  relatedFeature: string | null;
}

function toManifestSegment(hook: HookManifest): ManifestSegment {
  const info = getCategoryInfo(hook.id);
  const fileInfo = getTemplateFileInfo(hook.id);

  return {
    id: hook.id,
    name: hook.name,
    category: info.category,
    lifecycleStage: hook.stage,
    source: hook.template,
    sourceType: info.sourceType,
    trigger: hook.resolver ? 'conditional' : 'always',
    purpose: hook.userExplanation ?? hook.name,
    userExplanation: hook.userExplanation ?? hook.name,
    priority: `${hook.stage}:${hook.order}`,
    safetyTier: hook.safetyTier,
    transparencyTier: hook.transparencyTier,
    governanceTier: hook.governanceTier,
    allowLocalOverride: fileInfo ? !!fileInfo.local : false,
    disableable: hook.disableable,
    consumer: info.consumer,
    relatedFeature: null,
  };
}

// ---------------------------------------------------------------------------
// Supplemental segments — not in HookRegistry (observe-only + external)
// ---------------------------------------------------------------------------

/**
 * Segments outside the hook pipeline that the Console still needs to display.
 * Tier 2 (N2, M1, M2): observe-only trace adapters — no resolver, no versioning.
 * External (H1, H2, H3): Claude Code shell hooks — separate injection system.
 */
const SUPPLEMENTAL_SEGMENTS: ManifestSegment[] = [
  {
    id: 'N2',
    name: '对话历史增量',
    category: 'navigation',
    lifecycleStage: 'per-turn',
    source: 'route-helpers.ts',
    sourceType: 'observe-only',
    trigger: 'always',
    purpose: 'Conversation history delta — previous unread messages from other cats',
    userExplanation: '其他猫在你上次发言后说了什么（增量对话历史）',
    priority: 'per-turn:observe',
    safetyTier: 'readonly',
    transparencyTier: 'visible-by-default',
    governanceTier: 'immutable',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'route-assembler',
    relatedFeature: null,
  },
  {
    id: 'M1',
    name: 'Dispatch 任务上下文',
    category: 'transport',
    lifecycleStage: 'per-turn',
    source: 'invoke-single-cat.ts',
    sourceType: 'observe-only',
    trigger: 'conditional',
    purpose: 'Dispatch mission context (F070) — external project context for dispatched invocations',
    userExplanation: '外部项目 dispatch 时注入的任务上下文（missionPrefix）',
    priority: 'per-turn:transport',
    safetyTier: 'readonly',
    transparencyTier: 'visible-by-default',
    governanceTier: 'immutable',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'invocation-layer',
    relatedFeature: 'F070',
  },
  {
    id: 'M2',
    name: 'Transcript 路径提示',
    category: 'transport',
    lifecycleStage: 'per-turn',
    source: 'invoke-single-cat.ts',
    sourceType: 'observe-only',
    trigger: 'always',
    purpose: 'Transcript path hints — always appended for session continuity',
    userExplanation: '会话 transcript 路径信息（始终附加）',
    priority: 'per-turn:transport',
    safetyTier: 'readonly',
    transparencyTier: 'debug-only',
    governanceTier: 'immutable',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'invocation-layer',
    relatedFeature: null,
  },
  {
    id: 'H1',
    name: 'SessionStart Hook',
    category: 'external',
    lifecycleStage: 'session-init',
    source: '.claude/hooks/',
    sourceType: 'shell-hook',
    trigger: 'always',
    purpose: 'Claude Code SessionStart shell hook — runs on session start, output goes to tool_result',
    userExplanation: 'Claude Code 会话启动时运行的 shell hook',
    priority: 'session-init:external',
    safetyTier: 'readonly',
    transparencyTier: 'opt-in-view',
    governanceTier: 'human-gated',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
    relatedFeature: null,
  },
  {
    id: 'H2',
    name: 'PostCompact Hook',
    category: 'external',
    lifecycleStage: 'session-init',
    source: '.claude/hooks/',
    sourceType: 'shell-hook',
    trigger: 'conditional',
    purpose: 'Claude Code PostCompact shell hook — runs after context compaction',
    userExplanation: 'Claude Code 压缩上下文后运行的 shell hook',
    priority: 'session-init:external',
    safetyTier: 'readonly',
    transparencyTier: 'opt-in-view',
    governanceTier: 'human-gated',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
    relatedFeature: null,
  },
  {
    id: 'H3',
    name: 'SessionStop Hook',
    category: 'external',
    lifecycleStage: 'session-init',
    source: '.claude/hooks/',
    sourceType: 'shell-hook',
    trigger: 'always',
    purpose: 'Claude Code SessionStop shell hook — runs on session end, output does NOT enter model prompt',
    userExplanation: 'Claude Code 会话结束时运行的 shell hook（不进 model prompt）',
    priority: 'session-init:external',
    safetyTier: 'readonly',
    transparencyTier: 'debug-only',
    governanceTier: 'human-gated',
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
    relatedFeature: null,
  },
];

// ---------------------------------------------------------------------------
// Registry singleton (lazy init, scan once per process)
// ---------------------------------------------------------------------------

let cachedResult: { hookSegments: ManifestSegment[]; allSegments: ManifestSegment[] } | null = null;

function getManifestSegments(): { hookSegments: ManifestSegment[]; allSegments: ManifestSegment[] } {
  if (cachedResult) return cachedResult;

  const root = findProjectRoot();
  const hooksDir = `${root}/assets/prompt-hooks`;
  const templatesDir = `${root}/assets/prompt-templates`;
  const registry = new HookRegistry(hooksDir, templatesDir);
  const hooks = registry.scan();

  const hookSegments = hooks
    .map(toManifestSegment)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const allSegments = [...hookSegments, ...SUPPLEMENTAL_SEGMENTS].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  );

  cachedResult = { hookSegments, allSegments };
  return cachedResult;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const promptInjectionManifestRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/prompt-injection/manifest', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }

    try {
      const { hookSegments, allSegments } = getManifestSegments();
      return {
        schemaVersion: '2.0.0',
        segments: allSegments,
        totalActive: hookSegments.length,
        totalObserveOnly: SUPPLEMENTAL_SEGMENTS.filter((s) => s.sourceType === 'observe-only').length,
        totalExternal: SUPPLEMENTAL_SEGMENTS.filter((s) => s.sourceType === 'shell-hook').length,
      };
    } catch (e) {
      reply.status(500);
      return { error: `Failed to build manifest: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
};
