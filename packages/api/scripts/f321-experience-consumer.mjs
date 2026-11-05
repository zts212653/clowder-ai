// Isolated CLI execution and public event capture; no model reasoning is retained.
import { spawn } from 'node:child_process';

export function runConsumer(args, env, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('codex', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 120000);
    child.stdout.on('data', (part) => {
      stdout += part;
    });
    child.stderr.on('data', (part) => {
      stderr += part;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, timedOut, exitCode });
    });
    child.stdin.end(input);
  });
}
export function evidenceItems(stdout) {
  return stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed') return [{ type: event.type, usage: event.usage }];
      if (event.type === 'error') return [{ type: event.type, message: event.message }];
      if (event.item && ['agent_message', 'mcp_tool_call'].includes(event.item.type)) return [event];
    } catch {
      /* CLI non-JSON diagnostics are not model answers. */
    }
    return [];
  });
}
