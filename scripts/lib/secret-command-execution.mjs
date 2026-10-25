import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { protectSecretToolResult } from './secret-tool-io.mjs';

/** Wrappers may exit immediately after this function resolves; a pipe write must finish first. */
function writeOutput(stream, bytes) {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function notify(notice) {
  // Callback auth/refresh stays in the canonical host-owned MCP implementation.
  const { recordSecretExposure } = await import('../../packages/mcp-server/dist/secret-tool-guard.js');
  await recordSecretExposure(notice);
}

/** Buffer bounded output so a credential cannot be streamed past the redactor. */
export async function executeSecretSafeCommand(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const safe = await protectSecretToolResult(
    {
      content: [
        { type: 'text', text: result.stdout?.toString('utf8') ?? '' },
        { type: 'text', text: result.stderr?.toString('utf8') ?? '' },
      ],
    },
    { callId: `shell:${randomUUID()}`, notify },
  );
  if (result.error) {
    await writeOutput(
      process.stderr,
      'command_output_unavailable: execution failed or exceeded the bounded output limit.\n',
    );
    return 1;
  }
  await writeOutput(process.stdout, safe._meta?.secretExposure ? safe.content[0].text : result.stdout);
  await writeOutput(process.stderr, safe._meta?.secretExposure ? safe.content[1].text : result.stderr);
  for (const notice of safe.content.slice(2)) await writeOutput(process.stderr, `${notice.text}\n`);
  return result.status ?? 1;
}
