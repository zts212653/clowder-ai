import { summarizeAgyStreamJsonTurn as summarize } from '@clowder-ai/agent-access/runtime/agy/agy-stream-json-parser';
import { classifyCliError } from '../../../../../utils/cli-diagnostics.js';

export * from '@clowder-ai/agent-access/runtime/agy/agy-stream-json-parser';

export function agyTerminalPolicyRejected(error: string): boolean {
  const reason = classifyCliError(error);
  return reason === 'auth_failed' || reason === 'upstream_policy_reject';
}

export function summarizeAgyStreamJsonTurn(lines: Iterable<string>, terminalPolicyRejected?: boolean) {
  return summarize(lines, terminalPolicyRejected ?? agyTerminalPolicyRejected);
}
