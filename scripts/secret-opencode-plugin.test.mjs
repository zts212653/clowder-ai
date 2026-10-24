import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretContentProtection } from './secret-opencode-plugin.mjs';

test('an unavailable OpenCode MCP adapter blocks external tools while local repair retains content/read checks', async () => {
  const guard = await SecretContentProtection({ directory: process.cwd() });
  try {
    await guard['tool.execute.before']({ tool: 'bash', callID: 'local' }, { args: { command: 'printf clean' } });
    await guard['tool.execute.after']({ callID: 'local' });
    await assert.rejects(
      guard['tool.execute.before']({ tool: 'read', callID: 'credential' }, { args: { filePath: '.env.local' } }),
    );
    await assert.rejects(
      guard['tool.execute.before']({ tool: 'external_browser_upload', callID: 'send' }, { args: { path: 'note.txt' } }),
      /secret_native_guard_unavailable/,
    );
  } finally {
    await guard.event({ event: { type: 'server.instance.disposed' } });
  }
});
