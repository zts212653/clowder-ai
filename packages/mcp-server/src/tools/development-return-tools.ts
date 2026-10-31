import { type DevelopmentReturnActionV1, developmentReturnActionV1Schema } from '@cat-cafe/shared';
import { callbackPost } from './callback-tools.js';
import { defineDevelopmentTool } from './development-tool-definition.js';
import type { ToolResult } from './file-tools.js';

export const developmentReturnInputSchema = {
  ...developmentReturnActionV1Schema.shape,
  predecessorRegistrationId: developmentReturnActionV1Schema.shape.predecessorRegistrationId.describe(
    'Required when this owner/Task has return history: exact eligible terminal predecessor, or the one untouched waiting predecessor whose reporter generation the current action-lease proves was superseded in the same approved child. The latter is retired atomically with successor registration; reported, delivering, cancelled, or mismatched predecessors cannot be superseded. Only one active return is allowed.',
  ),
  action: developmentReturnActionV1Schema.shape.action
    .exclude(['read'])
    .describe(
      'register: original Task owner binds an approved final-only execution; report: child submits its persisted final result. Read coordinates with read_development_return.',
    ),
  registrationId: developmentReturnActionV1Schema.shape.registrationId.describe(
    'Exact server registration ID, required for report; omit on read to discover registrations for this execution thread.',
  ),
  taskId: developmentReturnActionV1Schema.shape.taskId.describe(
    'Original scoped Task ID; register only in its owner thread, never adopt it into a child thread.',
  ),
  expectedRevision: developmentReturnActionV1Schema.shape.expectedRevision.describe(
    'Current Task-owner revision, required for register; stale or terminal work cannot be registered.',
  ),
  executionThreadId: developmentReturnActionV1Schema.shape.executionThreadId.describe(
    'Approved final-only child thread associated with the exact original human source.',
  ),
  sourceActionRef: developmentReturnActionV1Schema.shape.sourceActionRef.describe(
    'Proposal-source return (the first registration, or a newly approved execution after a terminal predecessor): exact message:<id> authorization shared by the Task and that proposal. Current same-child delegate lineage, including an initial g1 terminal replacement or later return/replacement, uses exact action-lease:<leaseId>:<generation> from the admitted receipt plus predecessorRegistrationId.',
  ),
  expectedSignal: developmentReturnActionV1Schema.shape.expectedSignal.describe(
    'terminal_report, required for register.',
  ),
  slaUntil: developmentReturnActionV1Schema.shape.slaUntil.describe(
    'Explicit future epoch-ms return-review budget within 7 days; internal execution bound, not a user business deadline or Schedule item.',
  ),
  report: developmentReturnActionV1Schema.shape.report.describe(
    'Required for report: this cat’s persisted final message ID, completed/failed/blocked outcome, and real evidence refs. Report submission does not close the Task or approve an Artifact.',
  ),
};
export async function handleDevelopmentReturn(input: DevelopmentReturnActionV1): Promise<ToolResult> {
  return callbackPost('/api/callbacks/development-return', developmentReturnActionV1Schema.parse(input));
}
export async function handleReadDevelopmentReturn(
  input: Pick<DevelopmentReturnActionV1, 'registrationId'>,
): Promise<ToolResult> {
  return handleDevelopmentReturn({ ...input, action: 'read' });
}
export const developmentReturnTools = [
  defineDevelopmentTool({
    name: 'cat_cafe_read_development_return',
    description:
      'Read the registered owner return connection for this execution. Use when: an approved development child needs its final-only reporting coordinates, or the original owner verifies its exact registration. Not for: reading the original Task from a child, registering a wait or reporting completion. Output: owner-private state or child-safe registration ID, signal, return budget and status. GOTCHA: absent registration is not permission to create or move the original Task; only the original owner can register it.',
    inputSchema: { registrationId: developmentReturnInputSchema.registrationId },
    handler: handleReadDevelopmentReturn,
    sourceFile: 'development-return-tools.ts',
    exportName: 'handleReadDevelopmentReturn',
    callbackFile: 'callback-development-return-routes.ts',
    actions: ['read'],
  }),
  defineDevelopmentTool({
    name: 'cat_cafe_development_return',
    description:
      'Register or complete the original owner’s durable final-only development return connection. ' +
      'Use when: an approved execution child is doing accepted scoped development and its original Task owner needs a terminal result or bounded fact review across invocations. ' +
      'Not for: creating work, business reminders, replacing a human decision, generic cross-thread messages, or reading another thread’s Task. ' +
      'Output: private owner registration, child-safe reporting coordinates, or actual report delivery state. ' +
      'GOTCHA: register in the original owner thread before waiting; the child reads/report coordinates only. A current delegate lineage reuses the approved child and exact action-lease generation across an initial terminal replacement, explicit returns, or later server-terminal replacements. When that lease proves the existing untouched waiting reporter was superseded, register atomically retires the old return and creates one successor; never cancel, rewrite, or revive the old registration manually. Moving a returned generation to another child requires an exact cat/thread pair from its own current, independently approved proposal for the same Task and scope. Persist the final result first, then report its source message. Event and timeout share one wake, and the original owner must reread current work and act. A wake is not evidence that development continued.',
    inputSchema: developmentReturnInputSchema,
    handler: handleDevelopmentReturn,
    sourceFile: 'development-return-tools.ts',
    exportName: 'handleDevelopmentReturn',
    callbackFile: 'callback-development-return-routes.ts',
    actions: ['register', 'report'],
  }),
] as const;
