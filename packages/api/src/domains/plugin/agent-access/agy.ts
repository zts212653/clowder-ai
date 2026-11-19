import { Readable } from 'node:stream';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { agentAccessAgyFrameSchema, agentAccessAgyTurnSchema } from '@clowder-ai/agent-contract/agy';
import { isCliError, isCliTimeout, isLivenessWarning } from '../../../utils/cli-spawn.js';
import { asRecord } from '../../cats/services/agents/providers/agy-native/agy-native-stream-validation.js';
import { sanitizeRawEvent, sanitizeStreamingDelta } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessAgyOutput(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return async () => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const { pluginInstanceId } = instance;
    const lifetime = runtime.nativeActions.activationSignal(pluginInstanceId);
    lifetime.throwIfAborted();

    return {
      lifetime,
      async *project(events: AsyncIterable<unknown>, credentials: readonly string[]) {
        const pending = new Map<number, { raw: unknown; line?: string }>();
        let inputEnded = false;
        const tails = new Map<number, string>();
        const source = Readable.from(
          (async function* () {
            let sequence = 0;
            for await (const raw of events) {
              lifetime.throwIfAborted();
              let line: string | undefined;
              if (!isCliError(raw) && !isCliTimeout(raw) && !isLivenessWarning(raw)) {
                const safe = asRecord(sanitizeRawEvent(sanitizeRawEvent(raw), credentials)) ?? {};
                const step = asRecord(safe.step_update);
                if (step?.step_type === 'user_input') {
                  delete step.text_delta;
                  delete step.tool_info;
                } else if (step && typeof step.step_index === 'number') {
                  const index = step.step_index;
                  const tail = tails.get(index) ?? '';
                  if (typeof step.text_delta === 'string' || (tail && step.state === 'DONE')) {
                    const redacted = sanitizeStreamingDelta(
                      tail + (typeof step.text_delta === 'string' ? step.text_delta : ''),
                      credentials,
                    );
                    if (step.state === 'DONE') tails.delete(index);
                    else tails.set(index, redacted.tail);
                    step.text_delta = redacted.text + (step.state === 'DONE' ? redacted.tail : '');
                  }
                } else if (safe.event === 'result') tails.clear();
                if (safe.event === 'init') safe.init = {};
                line = JSON.stringify(safe);
              }
              pending.set(sequence, { raw, line });
              yield { sequence: sequence++, line };
            }
            inputEnded = true;
          })(),
          { objectMode: true, highWaterMark: 1 },
        );

        try {
          const output = await runtime.invoke(pluginInstanceId, 'projectAgyOutput', { source, signal: lifetime });
          if (!output || typeof output !== 'object' || !(Symbol.asyncIterator in output))
            throw new Error('invalid_agy_output_stream');
          let next = 0;
          for await (const frame of output as AsyncIterable<unknown>) {
            lifetime.throwIfAborted();
            const { sequence, step } = agentAccessAgyFrameSchema.parse(frame);
            const input = pending.get(sequence);
            if (!input || sequence !== next++) throw new Error('invalid_agy_output_sequence');
            pending.delete(sequence);
            if (step) {
              const envelope = asRecord(input.raw);
              const nativeStep = envelope?.event === 'step_update' ? asRecord(envelope.step_update) : null;
              if (
                !nativeStep ||
                nativeStep.conversation_id !== step.conversationId ||
                (Number.isFinite(nativeStep.step_index) ? nativeStep.step_index : -1) !== step.stepIndex
              )
                throw new Error('invalid_agy_step_identity');
              const rawState = typeof nativeStep.state === 'string' ? nativeStep.state : '';
              const state = rawState === 'ACTIVE' || rawState === 'DONE' || rawState === 'ERROR' ? rawState : 'UNKNOWN';
              const nativeType = typeof nativeStep.step_type === 'string' ? nativeStep.step_type : 'unknown';
              const finish = nativeType === 'finish' && state === 'DONE' && nativeStep.tool_name === undefined;
              const tool = typeof nativeStep.tool_name === 'string' ? nativeStep.tool_name : null;
              if (
                step.rawState !== rawState ||
                step.state !== state ||
                step.stepType !== (finish ? 'tool' : nativeType) ||
                step.toolName !== (finish ? 'finish' : tool)
              )
                throw new Error('invalid_agy_step_evidence');
            }
            yield { ...input, step };
          }
          lifetime.throwIfAborted();
          if (!inputEnded || pending.size) throw new Error('incomplete_agy_output_stream');
        } finally {
          source.destroy();
        }
      },
      async summarize(lines: readonly string[], terminalPolicyRejected: boolean) {
        lifetime.throwIfAborted();
        const result = await runtime.invoke(pluginInstanceId, 'summarizeAgyTurn', { lines, terminalPolicyRejected });
        lifetime.throwIfAborted();
        return agentAccessAgyTurnSchema.parse(result);
      },
    };
  };
}

export type PrepareAgyOutput = ReturnType<typeof createAgentAccessAgyOutput>;
export type AgentAccessAgyOutput = Awaited<ReturnType<PrepareAgyOutput>>;
