import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { packageManagerInvocation } from './lib/package-manager-invocation.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { SUBSTITUTION } from './lib/shell-text.mjs';
import { appendNativeDenial } from './native-effect-audit.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';

/** Consume the shared execution view: quoted argv/body text never becomes a command. */
export function gateBackgroundDecision(payload) {
  if (payload?.tool_name !== 'Bash' || typeof payload.tool_input?.command !== 'string') return false;
  const host = hereDocumentView(payload.tool_input.command).host;
  const { pipelines } = executedInvocations(host);
  const background = payload.tool_input.run_in_background === true;
  return pipelines.flat().some(({ name, operands }) => {
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
    if (gateBackgroundDecision(payload)) {
      appendNativeDenial(payload, {
        decision: 'deny',
        reasonCode: 'gate_requires_managed_command',
        effect: 'process_control',
        target: { kind: 'ordinary', value: payload.cwd ?? '<unknown-cwd>' },
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
