import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretContentProtection } from './secret-opencode-plugin.mjs';

test('OpenCode keeps native shell checks without wrapping or inspecting third-party MCP', async () => {
  const guard = await SecretContentProtection({ directory: process.cwd() });
  try {
    await guard['tool.execute.before']({ tool: 'bash', callID: 'local' }, { args: { command: 'printf clean' } });
    await guard['tool.execute.after']({ callID: 'local' });
    await guard['tool.execute.before']({ tool: 'read', callID: 'credential' }, { args: { filePath: '.env.local' } });
    await guard['tool.execute.after']({ callID: 'credential' });
    await assert.doesNotReject(
      guard['tool.execute.before']({ tool: 'external_browser_upload', callID: 'send' }, { args: { path: 'note.txt' } }),
    );
  } finally {
    await guard.event({ event: { type: 'server.instance.disposed' } });
  }
});
