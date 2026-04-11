/**
 * F152 Phase C: Distillation MCP Tools
 * cat_cafe_mark_generalizable — mark evidence item for global reflow
 * cat_cafe_nominate_for_global — nominate candidate for distillation
 * cat_cafe_review_distillation — approve/reject distillation candidate
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

export const markGeneralizableInputSchema = {
  anchor: z.string().min(1).describe('Evidence anchor to mark'),
  generalizable: z.boolean().describe('true = candidate for global reflow, false = project-private'),
};

export async function handleMarkGeneralizable(input: { anchor: string; generalizable: boolean }): Promise<ToolResult> {
  try {
    const res = await fetch(`${API_URL}/api/evidence/${encodeURIComponent(input.anchor)}/generalizable`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generalizable: input.generalizable }),
    });
    if (!res.ok) {
      const text = await res.text();
      return errorResult(`Failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { ok: boolean; anchor: string; generalizable: boolean };
    return successResult(`Marked ${data.anchor} as generalizable=${data.generalizable}`);
  } catch (err) {
    return errorResult(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const nominateForGlobalInputSchema = {
  anchor: z.string().min(1).describe('Evidence anchor to nominate'),
  projectPath: z.string().min(1).describe('Absolute path to project root'),
  personNames: z.array(z.string()).optional().describe('Person names to sanitize (blocklist)'),
};

export async function handleNominateForGlobal(input: {
  anchor: string;
  projectPath: string;
  personNames?: string[];
}): Promise<ToolResult> {
  try {
    const res = await fetch(`${API_URL}/api/distillation/nominate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      return errorResult(`Nominate failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { id: string; status: string; anchor: string };
    return successResult(`Nominated ${data.anchor} → candidate ${data.id} (${data.status})`);
  } catch (err) {
    return errorResult(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const reviewDistillationInputSchema = {
  candidateId: z.string().min(1).describe('Distillation candidate ID'),
  decision: z.enum(['approve', 'reject']).describe('Review decision'),
  reviewerId: z.string().min(1).describe('Cat ID performing the review (e.g. "codex", "opus")'),
};

export async function handleReviewDistillation(input: {
  candidateId: string;
  decision: 'approve' | 'reject';
  reviewerId: string;
}): Promise<ToolResult> {
  try {
    const res = await fetch(`${API_URL}/api/distillation/${encodeURIComponent(input.candidateId)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: input.decision, reviewerId: input.reviewerId }),
    });
    if (!res.ok) {
      const text = await res.text();
      return errorResult(`Review failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { ok: boolean; id: string; decision: string };
    return successResult(`Candidate ${data.id}: ${data.decision}d`);
  } catch (err) {
    return errorResult(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const distillationTools = [
  {
    name: 'cat_cafe_mark_generalizable',
    description:
      'Mark an evidence item (lesson/decision) as generalizable for cross-project reflow, or as project-private. ' +
      'Items marked generalizable=true become candidates for distillation to the global knowledge layer.',
    inputSchema: markGeneralizableInputSchema,
    handler: handleMarkGeneralizable,
  },
  {
    name: 'cat_cafe_nominate_for_global',
    description:
      'Nominate a generalizable evidence item for distillation to global knowledge. ' +
      'The item must have generalizable=true. Creates a deidentified candidate for review.',
    inputSchema: nominateForGlobalInputSchema,
    handler: handleNominateForGlobal,
  },
  {
    name: 'cat_cafe_review_distillation',
    description:
      'Approve or reject a distillation candidate. Approved candidates are written to the global knowledge layer ' +
      'with project-specific identifiers removed. Rejected candidates are discarded.',
    inputSchema: reviewDistillationInputSchema,
    handler: handleReviewDistillation,
  },
] as const;
