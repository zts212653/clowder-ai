import { nativeSecretDenial } from './native-secret-policy.mjs';

export const name = 'cat-cafe-secret-content';
export const inject = ['tools', 'workingDirectory'];

/** The registry's monotonic guard covers native and nested PTC executions. */
export function apply(ctx) {
  if (typeof ctx.tools.guard !== 'function') throw new Error('secret_dsh_guard_api_unavailable');
  ctx.tools.guard((execution) => {
    if (!['bash', 'shell', 'exec_command', 'run_command'].includes(execution.name.toLowerCase())) return undefined;
    try {
      return (
        nativeSecretDenial({
          tool_name: execution.name,
          tool_input: execution.arguments,
          cwd: execution.agent?.session ? ctx.workingDirectory.get(execution.agent.session) : process.cwd(),
        }) ?? undefined
      );
    } catch {
      return 'secret_payload_uninspectable';
    }
  });
  ctx.provide('catCafeSecretContent', { active: true });
}
