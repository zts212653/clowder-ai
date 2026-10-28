import { secretShellDenial } from './native-secret-shell.mjs';

const SHELL_TOOLS = new Set([
  'bash',
  'exec_command',
  'shell',
  'shell_command',
  'run_command',
  'run_terminal_cmd',
  'execute_command',
]);

/** Gate recognised sends; local actions retain their ordinary permissions. */
export function nativeSecretDenial(payload) {
  const input = payload?.tool_input;
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (!input || (typeof input !== 'object' && typeof input !== 'string')) return null;
  if (!SHELL_TOOLS.has(tool.toLowerCase())) return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const command = typeof input === 'string' ? input : (input.command ?? input.cmd);
  return typeof command === 'string' ? secretShellDenial(command, cwd) : null;
}
