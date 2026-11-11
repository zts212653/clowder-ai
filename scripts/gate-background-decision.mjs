import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { packageManagerInvocation } from './lib/package-manager-invocation.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { SUBSTITUTION } from './lib/shell-text.mjs';
import { appendNativeDenial } from './native-effect-audit.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { expandSegmentBindings } from './native-effect-shell-expansion.mjs';

/** Consume the shared execution view: quoted argv/body text never becomes a command. */
export function gateBackgroundDecision(payload) {
  return Boolean(gateBackgroundFinding(payload));
}

export function gateBackgroundFinding(payload) {
  if (payload?.tool_name !== 'Bash' || typeof payload.tool_input?.command !== 'string') return false;
  const host = hereDocumentView(payload.tool_input.command).host;
  const parts = splitShellExecutionSegmentsWithSeparators(host);
  const contexts = segmentContexts(parts, payload.cwd);
  const contextual = parts.flatMap((part, index) =>
    contexts[index].flatMap(({ directory, bindings }) => {
      const command = segmentCommandText(part.text);
      return expandSegmentBindings(command, bindings).flatMap((variant) =>
        executedInvocations(variant.argvPreserved ? variant.text : command, { cwd: directory }).pipelines.flat(),
      );
    }),
  );
  // Preserve root parameter/code-input facts (e.g. set -- pnpm gate; "$@").
  // Only a generated script selector is reconsidered in its local bindings.
  const original = executedInvocations(host)
    .pipelines.flat()
    .filter(({ name, operands }) => {
      const command = packageManagerInvocation(name, operands);
      const script = command.script ?? '';
      return command.kind !== 'script' || (!script.includes(SUBSTITUTION) && !/\$/.test(script));
    });
  const calls = [...original, ...contextual];
  const background = payload.tool_input.run_in_background === true;
  return calls.find(({ name, operands }) => {
    if (name === undefined)
      return operands.includes('gate') || operands.some((word) => /pre-merge-check\.(?:sh|bash)$/.test(word));
    if (/^pre-merge-check\.(?:sh|bash)$/.test(name ?? '')) return true;
    if (!['pnpm', 'npm'].includes(name)) return false;
    const command = packageManagerInvocation(name, operands);
    if (command.kind === 'unknown') return command.candidates.some((word) => /(?:^|\s)gate(?:\s|$)/.test(word));
    if (command.kind !== 'script') return false;
    const script = command.script;
    return (
      script === 'gate' ||
      script?.includes(SUBSTITUTION) ||
      /\$/.test(script ?? '') ||
      (background && /^(?:check|test|build|lint)(?::|$)|^alpha:(?:start|test)$/.test(script ?? ''))
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const payload = JSON.parse(input);
    const finding = gateBackgroundFinding(payload);
    if (finding) {
      appendNativeDenial(payload, {
        decision: 'deny',
        reasonCode: 'gate_requires_managed_command',
        effect: 'process_control',
        target: { kind: 'ordinary', value: payload.cwd ?? '<unknown-cwd>' },
        source: { cwd: finding.cwd ?? payload.cwd },
        offendingClause: finding.text,
      });
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              '⛔ 检测到前台 full gate 或裸后台 gate 类命令，已阻止（F167 Phase P-0）。请调用 cat_cafe_hold_ball({ wakeWhen: { command } })：服务端托管、Hub 显示运行状态、终态自动唤醒；不要改成前台轮询。',
          },
        }),
      );
    }
  } catch {
    process.exitCode = 1;
  }
}
