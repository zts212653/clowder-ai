/**
 * Perspective Run Tool
 * MCP 工具: run git-backed live query plans and return traceable anchors.
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

type PerspectiveDrillDown = {
  tool: string;
  params?: Record<string, string>;
  hint?: string;
};

type PerspectiveRunResponse = {
  planId: string;
  runId: string;
  startedAt: string;
  actorCatId: string;
  steps: Array<{
    id: string;
    type: string;
    status: string;
    queryOrAnchor?: string;
    hitCount?: number;
    openedCount?: number;
    degraded?: boolean;
    degradeReason?: string;
    effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
  }>;
  candidateAnchors: Array<{
    anchor: string;
    title?: string;
    sourceStepId?: string;
    rank?: number;
    drillDown?: PerspectiveDrillDown;
  }>;
  openedAnchors: Array<{
    anchor: string;
    status: string;
    tool?: string;
    content?: string;
    error?: string;
  }>;
  warnings: Array<{
    stepId: string;
    code: string;
    message: string;
  }>;
};

export const runPerspectiveInputSchema = {
  planId: z
    .string()
    .regex(/^[^/]+\/[^/]+$/)
    .describe('Perspective plan id in the form <featureId>/<slug>, e.g. F209/f209-phase-d-orientation'),
  actorCatId: z.string().optional().describe('Cat id running the Perspective, e.g. codex'),
};

export async function handleRunPerspective(input: {
  planId: string;
  actorCatId?: string | undefined;
}): Promise<ToolResult> {
  const [featureId, slug] = input.planId.split('/');
  if (!featureId || !slug) {
    return errorResult('Perspective planId must be <featureId>/<slug>');
  }

  const params = new URLSearchParams();
  if (input.actorCatId) params.set('actorCatId', input.actorCatId);
  const query = params.toString();
  const url = `${API_URL}/api/perspectives/${encodeURIComponent(featureId)}/${encodeURIComponent(slug)}/run${
    query ? `?${query}` : ''
  }`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Perspective run failed for ${input.planId} (${response.status}): ${text}`);
    }
    const data = (await response.json()) as PerspectiveRunResponse;
    return successResult(formatPerspectiveRun(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Perspective run request failed for ${input.planId}: ${message}`);
  }
}

function formatPerspectiveRun(run: PerspectiveRunResponse): string {
  const lines = [
    `Perspective run: ${run.planId}`,
    `runId: ${run.runId}`,
    `actorCatId: ${run.actorCatId}`,
    `startedAt: ${run.startedAt}`,
    '',
    'steps:',
  ];

  for (const step of run.steps) {
    lines.push(...formatStepLines(step));
  }

  if (run.candidateAnchors.length > 0) {
    lines.push('', 'candidateAnchors:');
    for (const candidate of run.candidateAnchors) {
      lines.push(...formatCandidateLines(candidate));
    }
  }

  if (run.openedAnchors.length > 0) {
    lines.push('', 'openedAnchors:');
    for (const opened of run.openedAnchors) {
      lines.push(...formatOpenedAnchorLines(opened));
    }
  }

  if (run.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of run.warnings) {
      lines.push(formatWarningLine(warning));
    }
  }

  lines.push(
    '',
    'Boundary: Perspective returns route hints and anchors, not fetched evidence content or a conclusion.',
  );
  return lines.join('\n');
}

function formatStepLines(step: PerspectiveRunResponse['steps'][number]): string[] {
  const meta = [
    `status=${step.status}`,
    step.hitCount != null ? `hits=${step.hitCount}` : null,
    step.openedCount != null ? `opened=${step.openedCount}` : null,
    step.degraded != null ? `degraded=${step.degraded}` : null,
    step.effectiveMode ? `effectiveMode=${step.effectiveMode}` : null,
    step.degradeReason ? `degradeReason=${step.degradeReason}` : null,
  ].filter(Boolean);
  const lines = [`- ${step.id} [${step.type}] ${meta.join(' ')}`];
  if (step.queryOrAnchor) lines.push(`  queryOrAnchor: ${step.queryOrAnchor}`);
  return lines;
}

function formatCandidateLines(candidate: PerspectiveRunResponse['candidateAnchors'][number]): string[] {
  const prefix = candidate.rank != null ? `${candidate.rank}.` : '-';
  const lines = [`${prefix} ${candidate.anchor}${candidate.title ? ` — ${candidate.title}` : ''}`];
  if (candidate.sourceStepId) lines.push(`   sourceStepId: ${candidate.sourceStepId}`);
  if (candidate.drillDown) lines.push(...formatDrillDownLines(candidate.drillDown));
  return lines;
}

function formatOpenedAnchorLines(opened: PerspectiveRunResponse['openedAnchors'][number]): string[] {
  const label = opened.status === 'route_identified' ? 'route' : 'opened';
  const lines = [`- ${label}: ${opened.anchor} status=${opened.status}${opened.tool ? ` tool=${opened.tool}` : ''}`];
  if (opened.content) lines.push(`  ${opened.status === 'route_identified' ? 'hint' : 'content'}: ${opened.content}`);
  if (opened.error) lines.push(`  error: ${opened.error}`);
  return lines;
}

function formatWarningLine(warning: PerspectiveRunResponse['warnings'][number]): string {
  return `- warning[${warning.stepId}/${warning.code}]: ${warning.message}`;
}

function formatDrillDownLines(drillDown: PerspectiveDrillDown): string[] {
  const params = Object.entries(drillDown.params ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const lines = [`   drillDown: ${drillDown.tool}${params ? ` (${params})` : ''}`];
  if (drillDown.hint) lines.push(`     hint: ${drillDown.hint}`);
  return lines;
}

export const perspectiveTools = [
  {
    name: 'cat_cafe_run_perspective',
    description:
      'Run a git-backed Perspective live query plan by id and return traceable steps, candidate anchors, typed reader route hints, degraded metadata, and warnings. ' +
      'Use this when a cat-authored plan should reopen a known investigation route. It returns route hints and anchors only; cats must invoke the typed reader to fetch evidence content. It does not write conclusions or store result sets.',
    inputSchema: runPerspectiveInputSchema,
    handler: handleRunPerspective,
  },
] as const;
