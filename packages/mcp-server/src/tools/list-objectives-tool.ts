/**
 * F257 修复清单 #3 — List Objectives Tool
 * MCP 工具: 只读发现 report_harness_signal 可用的 objectiveId，取代"三次上报三次考古"。
 */

import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('list-objectives-tool.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'local-runtime',
});

const API_URL = process.env.CAT_CAFE_API_URL ?? 'http://localhost:3004';

interface ObjectiveDefinition {
  id: string;
  label?: string;
  statement: string;
  evaluationModelId?: string;
}

interface EvaluationModelDefinition {
  id: string;
  label: string;
  metrics: Array<{ id: string; label: string; kind: string }>;
}

export async function handleListObjectives(): Promise<ToolResult> {
  const url = `${API_URL}/api/callbacks/objectives`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Failed to fetch objectives (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      objectives?: ObjectiveDefinition[];
      evaluationModels?: EvaluationModelDefinition[];
    };
    const objectives = data.objectives ?? [];
    if (objectives.length === 0) {
      // API fail-closes (503) on unreadable/malformed/invalid registry — a 200 with
      // an empty list is therefore a genuinely empty (but valid) catalog, not a
      // masked failure (2a R1 P1-2).
      return successResult('No objectives registered yet.');
    }
    const models = new Map((data.evaluationModels ?? []).map((model) => [model.id, model]));
    const lines = objectives.map((objective) => {
      const model = objective.evaluationModelId ? models.get(objective.evaluationModelId) : undefined;
      const metrics = model?.metrics.map((metric) => `${metric.id}[${metric.kind}]`).join(', ');
      return `- ${objective.id} — ${objective.statement}${model ? `\n  evaluationModel: ${model.id}\n  metrics: ${metrics}` : ''}`;
    });
    return successResult(
      `Valid objectiveIds for cat_cafe_report_harness_signal (pick one; do not invent):\n${lines.join('\n')}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`List objectives request failed: ${message}`);
  }
}

export const listObjectivesInputSchema = {};

export const listObjectivesTools = [
  defineTool({
    name: 'cat_cafe_list_objectives',
    description:
      'F257: list registered Objectives with their Evaluation Model and Metric ids for cat_cafe_report_harness_signal. ' +
      'Call this BEFORE report_harness_signal to pick a valid objectiveId instead of guessing — no more archaeology. ' +
      'Read-only; the set grows as objectives are canonized.',
    inputSchema: listObjectivesInputSchema,
    handler: handleListObjectives,
    governance: {
      implementationExport: 'handleListObjectives',
      action: 'list',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
    },
  }),
] as const;
