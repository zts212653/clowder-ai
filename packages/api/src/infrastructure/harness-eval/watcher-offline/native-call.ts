import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliEffortPreset, createCatId } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../../../domains/cats/services/agents/providers/ClaudeAgentService.js';
import { CodexAgentService } from '../../../domains/cats/services/agents/providers/CodexAgentService.js';
import type { AgentServiceOptions } from '../../../domains/cats/services/types.js';
import { spawnCli } from '../../../utils/cli-spawn.js';
import type { WatcherCandidate } from './candidate.js';
import { WATCHER_INSTRUCTIONS } from './instructions.js';
import { restrictWatcherLaunch } from './launch.js';
import { NativeWatcherObservation } from './native-observation.js';
import { textDigest } from './protocol.js';
import type { WatcherAdapter, WatcherCall } from './run-case.js';
import { WATCHER_WIRE_SCHEMA } from './wire-schema.js';

export function nativeWatcherAdapter(
  candidate: WatcherCandidate,
  input: { workingDirectory: string; effort: CliEffortPreset; timeoutMs: number },
): WatcherAdapter {
  mkdirSync(input.workingDirectory, { recursive: true, mode: 0o700 });
  const schema = JSON.stringify(WATCHER_WIRE_SCHEMA);
  const schemaPath = join(input.workingDirectory, 'response-schema.json');
  writeFileSync(schemaPath, schema, { mode: 0o600, flag: 'wx' });
  const instructions =
    'Identity: @' +
    candidate.catId +
    '; model=' +
    candidate.model +
    '. Role: isolated offline watcher.\n' +
    WATCHER_INSTRUCTIONS;
  // The evaluator owns these frozen role instructions. Ordinary member L0 is unchanged.
  // The hash below covers this role, not the CLI's built-in system prompt.
  const compileInstructions = async ({ catId, outPath }: { catId: string; outPath?: string }) => {
    if (catId !== candidate.catId) throw new Error('watcher_identity_mismatch');
    if (outPath) writeFileSync(outPath, instructions, { mode: 0o600 });
    return instructions;
  };

  return {
    next: async (prompt, outerSignal) => {
      const started = Date.now();
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(input.timeoutMs),
        ...(outerSignal ? [outerSignal] : []),
      ]);
      const observation = new NativeWatcherObservation(candidate.provider, candidate.model, () => controller.abort());
      const identity = {
        catId: createCatId(candidate.catId),
        model: candidate.model,
        l0CompilerFn: compileInstructions,
      };
      const service =
        candidate.provider === 'openai'
          ? new CodexAgentService({ ...identity, carrierMode: 'exec_json' })
          : new ClaudeAgentService(identity);
      let launches = 0;
      const launchEvidence: Pick<WatcherCall, 'nativeCommand' | 'nativeEffort' | 'launchDigest'> = {};
      const options: AgentServiceOptions = {
        ...candidate.options,
        sessionId: undefined,
        invocationId: 'watcher-offline-' + randomUUID(),
        workingDirectory: input.workingDirectory,
        reasoningEffortOverride: input.effort,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
        signal,
        spawnCliOverride: async function* (original) {
          if (++launches !== 1) throw new Error('watcher_implicit_retry_rejected');
          const restricted = restrictWatcherLaunch(candidate.provider, original, schemaPath, schema);
          launchEvidence.nativeCommand = restricted.command;
          launchEvidence.launchDigest = textDigest(JSON.stringify(restricted.args));
          const effortIndex = restricted.args.indexOf('--effort');
          launchEvidence.nativeEffort =
            effortIndex >= 0
              ? (restricted.args[effortIndex + 1] ?? null)
              : (restricted.args.map((arg) => /^model_reasoning_effort="?([a-z]+)"?$/.exec(arg)?.[1]).find(Boolean) ??
                null);
          for await (const event of spawnCli({ ...restricted, signal, timeoutMs: input.timeoutMs })) {
            observation.observe(event);
            yield event;
          }
        },
      };
      try {
        for await (const message of service.invoke(prompt, options)) observation.observeMessage(message);
      } catch {
        observation.observeMessage({ type: 'error', errorCode: 'native_invoke_failed' });
      }
      return {
        ...observation.finish(Date.now() - started, signal.aborted),
        ...launchEvidence,
        instructionDigest: textDigest(instructions),
      };
    },
  };
}
