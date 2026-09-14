/**
 * Prompt Injection Manifest Route — F237 Phase 2
 *
 * GET /api/prompt-injection/manifest — aggregate 47 hook.yaml manifests
 * into the ManifestSegment[] shape the Console frontend expects.
 *
 * Replaces the old monolithic assets/prompt-injection-manifest.yaml
 * read from the prompt pipeline's shared HookRegistry (reload-aware).
 */

import { existsSync } from 'node:fs';
import type { HookManifest, SafetyTier, SegmentEnablementMatrix } from '@cat-cafe/shared';
import { resolveSegmentEnablementMatrix } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  getTemplateFileInfo,
  getTemplateOverlayPath,
} from '../domains/cats/services/context/prompt-template-loader.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { HookRegistry } from '../domains/prompt-hooks/HookRegistry.js';
import { getOrCreateRegistry } from '../domains/prompt-hooks/PipelinePromptBuilder.js';
import { resolveUserId } from '../utils/request-identity.js';

// ---------------------------------------------------------------------------
// Prefix → category / consumer mapping
// ---------------------------------------------------------------------------

interface CategoryInfo {
  category: string;
  consumer: string;
  sourceType: string;
}

const PREFIX_MAP: Record<string, CategoryInfo> = {
  L: { category: 'session-governance', consumer: 'hook-pipeline', sourceType: 'template' },
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
// Route options
// ---------------------------------------------------------------------------

export interface PromptInjectionManifestRoutesOptions {
  /** Runtime override store. When absent, matrix uses default override state. */
  overrideStore?: HookOverrideStore;
  /**
   * Registry source. Defaults to the prompt pipeline singleton so the Console
   * list follows `resetPipelineSingleton()` (governance `add` → reloadPipeline)
   * without a restart. Tests inject a registry over a fixture directory.
   */
  getRegistry?: () => HookRegistry;
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
  enablementMatrix: SegmentEnablementMatrix;
}

interface SegmentMatrixInputs {
  id: string;
  safetyTier: SafetyTier;
  allowLocalOverride: boolean;
  disableable: boolean;
}

async function buildEnablementMatrix(
  segment: SegmentMatrixInputs,
  overrideStore: HookOverrideStore | undefined,
): Promise<SegmentEnablementMatrix> {
  let enabled = true;
  let hasOverride = false;
  let hasContentOverride = false;
  let hasVersionSnapshot = false;
  const availableEpochVersions: number[] = [];

  if (overrideStore) {
    const override = await overrideStore.getOverride(segment.id);
    if (override) {
      enabled = override.enabled !== false;
      hasOverride = true;
      hasContentOverride = typeof override.contentOverride === 'string' && override.contentOverride.length > 0;
    }
    if (typeof overrideStore.listVersions === 'function') {
      const versions = await overrideStore.listVersions(segment.id);
      if (versions.length > 0) {
        hasVersionSnapshot = true;
        for (const v of versions) availableEpochVersions.push(v.version);
      }
    }
  }

  let hasLocalOverlay = false;
  let hasBackup = false;
  const overlayPath = getTemplateOverlayPath(segment.id);
  if (overlayPath) {
    hasLocalOverlay = existsSync(overlayPath);
    hasBackup = existsSync(`${overlayPath}.bak`);
  }

  return resolveSegmentEnablementMatrix({
    segmentId: segment.id,
    safetyTier: segment.safetyTier,
    allowLocalOverride: segment.allowLocalOverride,
    disableable: segment.disableable,
    localOverlay: { hasOverlay: hasLocalOverlay, hasBackup },
    runtimeOverride: {
      enabled,
      hasOverride,
      hasContentOverride,
      hasVersionSnapshot,
      availableEpochVersions,
    },
  });
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
    enablementMatrix: undefined as unknown as SegmentEnablementMatrix,
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
function supplementalSegmentDefaults(id: string): Omit<ManifestSegment, keyof SegmentMatrixInputs> {
  return {
    name: '',
    category: '',
    lifecycleStage: '',
    source: '',
    sourceType: '',
    trigger: '',
    purpose: '',
    userExplanation: '',
    priority: '',
    transparencyTier: 'visible-by-default',
    governanceTier: 'immutable',
    consumer: '',
    relatedFeature: null,
    enablementMatrix: undefined as unknown as SegmentEnablementMatrix,
  };
}

const SUPPLEMENTAL_SEGMENTS: ManifestSegment[] = [
  {
    ...supplementalSegmentDefaults('N2'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'route-assembler',
  },
  {
    ...supplementalSegmentDefaults('M1'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'invocation-layer',
    relatedFeature: 'F070',
  },
  {
    ...supplementalSegmentDefaults('M2'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'invocation-layer',
  },
  {
    ...supplementalSegmentDefaults('H1'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
  },
  {
    ...supplementalSegmentDefaults('H2'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
  },
  {
    ...supplementalSegmentDefaults('H3'),
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
    allowLocalOverride: false,
    disableable: false,
    consumer: 'claude-code',
  },
];

// ---------------------------------------------------------------------------
// Segment derivation from the shared, reload-aware registry
// ---------------------------------------------------------------------------

// The registry is the only cache. A module-level scan cache here outlived
// `resetPipelineSingleton()`: after a governance `add` the hook was injected
// into every prompt while the Console still listed the startup set (D22,
// 2026-09-11). Deriving per request from the shared registry costs a map over
// ~50 in-memory manifests and keeps one truth for prompt and Console.
function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function getManifestSegments(registry: HookRegistry): {
  hookSegments: ManifestSegment[];
  allSegments: ManifestSegment[];
} {
  const hookSegments = registry
    .getAllHooks()
    .map((hook) => toManifestSegment(hook.manifest))
    .sort(byId);
  const allSegments = [...hookSegments, ...SUPPLEMENTAL_SEGMENTS].sort(byId);
  return { hookSegments, allSegments };
}

async function attachEnablementMatrices(
  segments: ManifestSegment[],
  overrideStore: HookOverrideStore | undefined,
): Promise<ManifestSegment[]> {
  const matrices = await Promise.all(
    segments.map((s) =>
      buildEnablementMatrix(
        {
          id: s.id,
          safetyTier: s.safetyTier as SafetyTier,
          allowLocalOverride: s.allowLocalOverride,
          disableable: s.disableable,
        },
        overrideStore,
      ),
    ),
  );
  return segments.map((s, i) => ({ ...s, enablementMatrix: matrices[i] }));
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const promptInjectionManifestRoutes: FastifyPluginAsync<PromptInjectionManifestRoutesOptions> = async (
  app,
  opts,
) => {
  app.get('/api/prompt-injection/manifest', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }

    try {
      const registry = (opts.getRegistry ?? getOrCreateRegistry)();
      const { hookSegments, allSegments } = getManifestSegments(registry);
      const segments = await attachEnablementMatrices(allSegments, opts.overrideStore);
      return {
        schemaVersion: '2.0.0',
        segments,
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
