import {
  type DeferredPersonMemoryInput,
  deferredPersonMemoryInputSchema,
  deferredPersonMemoryReceiptIdSchema,
  type ProactiveMemoryAbstentionInput,
  proactiveMemoryAbstentionInputSchema,
} from '@cat-cafe/shared';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';

import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineCanonicalTool = defineMcpCanonicalFactory(
  'proactive-memory-opportunity-tool.ts',
  './tools/callback-tools.js',
  {
    resourceFamily: 'memory-write',
    authority: 'callback-owner',
  },
);

export const proactiveMemoryAbstentionToolInputSchema = proactiveMemoryAbstentionInputSchema.shape;
export const deferredPersonMemoryToolInputSchema = deferredPersonMemoryInputSchema.shape;

type CallbackPost = (path: string, body: Record<string, unknown>) => Promise<ToolResult>;

export function createProactiveMemoryAbstentionTool(callbackPost: CallbackPost) {
  async function handleRecordProactiveMemoryAbstention(input: ProactiveMemoryAbstentionInput): Promise<ToolResult> {
    const parsed = proactiveMemoryAbstentionInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorResult('Invalid proactive-memory abstention input.');
    }
    const result = await callbackPost('/api/callbacks/record-proactive-memory-abstention', parsed.data);
    if (result.isError) return result;
    try {
      const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      if (body.status === 'stale_ignored') {
        return errorResult('Proactive-memory abstention was NOT recorded because this invocation is stale.');
      }
      return successResult(JSON.stringify({ status: 'recorded' }));
    } catch {
      return errorResult('Proactive-memory abstention callback returned an invalid response.');
    }
  }

  return {
    handleRecordProactiveMemoryAbstention,
    tool: defineCanonicalTool({
      name: 'cat_cafe_record_proactive_memory_abstention',
      description:
        'Record why you deliberately did not create an F276 person-memory proposal for the current proactive-memory opportunity. ' +
        'Use only after applying the proactive-memory-judgment gates and deciding to abstain. ' +
        'When the prompt prints an ASR write-opportunity ref, pass its exact opportunityId, dedupeLineage, and generation here; the server binds it to the authenticated invocation and rejects missing or forged refs. ' +
        'For ordinary proactive-memory opportunities without a printed write-opportunity ref, omit writeOpportunityRef. Never include transcript text, message contents, person details, owner IDs, or source coordinates in this receipt. ' +
        'NOT for proposal failures that you still intend to retry, or for recording a proposal success (use cat_cafe_propose_person_memory). ' +
        'Output is a content-free receipt used only for the incubating F282 cold-start evaluation and F276 disposition ledger.',
      inputSchema: proactiveMemoryAbstentionToolInputSchema,
      handler: handleRecordProactiveMemoryAbstention,
      governance: {
        implementationExport: 'handleRecordProactiveMemoryAbstention',
        action: 'update',
        risk: { level: 'write', openWorld: false },
        runtimeProfiles: ['full'],
      },
    }),
  };
}

export function createDeferredPersonMemoryTool(callbackPost: CallbackPost) {
  async function handleDeferPersonMemoryDelta(input: DeferredPersonMemoryInput): Promise<ToolResult> {
    const parsed = deferredPersonMemoryInputSchema.safeParse(input);
    if (!parsed.success) return errorResult('Invalid deferred person-memory receipt input.');
    const result = await callbackPost('/api/callbacks/defer-person-memory', parsed.data);
    if (result.isError) return result;
    try {
      const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      if (body.status === 'stale_ignored') {
        return errorResult('Deferred receipt was NOT created because this invocation is stale.');
      }
      return successResult(JSON.stringify({ ...body, proactiveMemoryOutcome: 'deferred_receipt_recorded' }));
    } catch {
      return errorResult('Deferred receipt callback returned an invalid response.');
    }
  }

  const handleWithdrawDeferredPersonMemory = (input: { receiptId: string }) =>
    callbackPost('/api/callbacks/person-memory/deferred/withdraw', { receiptId: input.receiptId });

  const handleForgetDeferredPersonMemory = (input: { receiptId: string }) =>
    callbackPost('/api/callbacks/person-memory/deferred/forget', { receiptId: input.receiptId });

  const receiptInputSchema = {
    receiptId: deferredPersonMemoryReceiptIdSchema.describe(
      'Exact deferred receipt ID returned by cat_cafe_defer_person_memory_delta.',
    ),
  };

  return {
    handleDeferPersonMemoryDelta,
    handleWithdrawDeferredPersonMemory,
    handleForgetDeferredPersonMemory,
    tool: defineCanonicalTool({
      name: 'cat_cafe_defer_person_memory_delta',
      description:
        'Capture a high-value interaction delta for a known person without interrupting the current task with an approval card. ' +
        'Use when the exact owner sources are available but immediate cat_cafe_propose_person_memory would disrupt the main task. ' +
        'Input contains only the subject plus exact message or attachment coordinates; owner, requester, invocation, source threads, digests, and visibility are server-derived. The receipt does not store message or transcript bodies. ' +
        'A bounded daily clerk reads only explicit deferred receipts and may create a normal rejectable F276 proposal; it never scans all conversation history and never materializes memory silently. ' +
        'Known person means an already registered private person or workspace person Entity. NOT for first-time identity capture, vague reminders, or unconfirmed ASR facts. ' +
        'For ASR or attachments, include an exact owner confirmation message when available; without confirmation the server records a non-actionable awaiting_confirmation receipt that the daily clerk cannot consume.' +
        ' When a daily-clerk write-opportunity is deferred again, pass both its exact writeOpportunityRef and reentryReceipt claim fence; the server atomically re-arms that same receipt and rejects any attempt to create a second lineage.',
      inputSchema: deferredPersonMemoryToolInputSchema,
      handler: handleDeferPersonMemoryDelta,
      governance: {
        implementationExport: 'handleDeferPersonMemoryDelta',
        action: 'create',
        risk: { level: 'write', openWorld: false },
        runtimeProfiles: ['full'],
        standaloneReason: {
          disposition: 'accepted-boundary',
          kind: 'side-effect-boundary',
          admissionRef: 'file:docs/features/F276-people-relationship-memory.md',
        },
      },
    }),
    lifecycleTools: [
      defineCanonicalTool({
        name: 'cat_cafe_withdraw_deferred_person_memory',
        description:
          'Withdraw one exact owner-private deferred person-memory receipt before it becomes a proposal. ' +
          'This removes it from the daily queue, purges its subject/source payload, and allows a later fresh capture of the same delta. ' +
          'NOT for an already-created F276 proposal; use the proposal card lifecycle for that.',
        inputSchema: receiptInputSchema,
        handler: handleWithdrawDeferredPersonMemory,
        governance: {
          implementationExport: 'handleWithdrawDeferredPersonMemory',
          action: 'close',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: {
            disposition: 'accepted-boundary',
            kind: 'side-effect-boundary',
            admissionRef: 'file:docs/features/F276-people-relationship-memory.md',
          },
        },
      }),
      defineCanonicalTool({
        name: 'cat_cafe_forget_deferred_person_memory',
        description:
          'Permanently purge one exact owner-private deferred person-memory receipt and every queue/dedupe locator. ' +
          'Destructive; use only on the owner’s explicit request. Names and aliases are never accepted as purge coordinates. ' +
          'If the receipt already created a proposal, this refuses the partial purge; use the exact F276 proposal hard-forget lifecycle instead.',
        inputSchema: receiptInputSchema,
        handler: handleForgetDeferredPersonMemory,
        governance: {
          implementationExport: 'handleForgetDeferredPersonMemory',
          action: 'close',
          risk: { level: 'destructive', openWorld: false },
          runtimeProfiles: ['full'],
          targetExposure: 'profile-gated',
          standaloneReason: {
            disposition: 'accepted-boundary',
            kind: 'destructive-boundary',
            admissionRef: 'file:docs/features/F276-people-relationship-memory.md',
          },
        },
      }),
    ],
  };
}
