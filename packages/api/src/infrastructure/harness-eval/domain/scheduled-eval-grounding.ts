import type { EvalCatInvocationPacket } from '../eval-cat-invocation.js';
import type { EvalDomainTriggerChannel } from './eval-domain-trigger-store.js';

const SCHEDULED_EVAL_REPOSITORY_GROUNDING = `## Scheduled eval repository grounding (shared checkout)

Scheduled domains can run concurrently in the same runtime worktree. That checkout is ADR-039 passive runtime state: do not run \`git pull\`, \`git merge\`, or \`git rebase\` there, and do not rebuild latest source in place. Bind deployed runtime truth to \`git rev-parse HEAD\`. When repository freshness matters, run \`git fetch origin main\`, bind repository truth to \`git rev-parse origin/main\`, and read repo-backed inputs with \`git show origin/main:<path>\`; execute latest source only in an isolated detached worktree. Pre/post observations are not atomic across peer invocations. Report named SHAs plus \`git rev-list --left-right --count HEAD...origin/main\`; command prose cannot prove which invocation moved HEAD and is not, by itself, a friction sample.`;

export interface ScheduledEvalTriggerGrounding {
  channel: EvalDomainTriggerChannel;
  windowKey: string;
  dedupeKey: string;
}

export function buildScheduledEvalInvocationMessage(
  invocation: EvalCatInvocationPacket,
  trigger?: ScheduledEvalTriggerGrounding,
): string {
  return [
    `## Eval Domain: ${invocation.domainId}`,
    '',
    ...(trigger
      ? [
          '## Invocation trigger',
          '',
          `Trigger channel: ${trigger.channel}`,
          `Window: ${trigger.windowKey}`,
          `Dedupe key: ${trigger.dedupeKey}`,
          'Invocation is only a wake attempt; it does not establish maturity, validity, or actionability.',
          'Reconstruct evidence and apply the domain maturity predicate and verdict action gate independently.',
          '',
        ]
      : []),
    SCHEDULED_EVAL_REPOSITORY_GROUNDING,
    '',
    invocation.instructions,
    '',
    '```json',
    JSON.stringify(invocation.context, null, 2),
    '```',
  ].join('\n');
}
