import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';

for (const providerName of ['google', 'Pi']) {
  for (const ending of ['complete', 'missing', 'truncated']) {
    test(`${providerName} ACP diagnostics redact ${ending} short-wrapped PEM before delivery`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'acp-context-pem-'));
      const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
      const body = key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
      const secretLines = body.match(/.{1,16}/g);
      const tail = ending === 'complete' ? '\n-----END PRIVATE KEY-----' : ending === 'truncated' ? '\n-----END' : '';
      writeFileSync(
        join(root, 'diagnostic.txt'),
        `previous benign context\n-----BEGIN PRIVATE KEY-----\n${secretLines.join('\n')}${tail}`,
      );
      const fixture = join(root, 'acp-fixture.mjs');
      writeFileSync(
        fixture,
        `import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = { jsonrpc: '2.0', id: m.id };
  if (m.method === 'initialize') reply.result = {
    protocolVersion: 1, agentInfo: { name: 'fixture', title: 'Fixture', version: '1' },
    agentCapabilities: { loadSession: true, promptCapabilities: {} }
  };
  else if (m.method === 'session/new') reply.result = { sessionId: 'fixture-session' };
  else if (m.method === 'session/prompt') reply.error = {
    code: -32603, message: 'upstream failed',
    data: { diagnostics: readFileSync(${JSON.stringify(join(root, 'diagnostic.txt'))}, 'utf8') }
  };
  else reply.result = {};
  process.stdout.write(JSON.stringify(reply) + '\\n');
});`,
      );
      const client = new AcpClient({ command: process.execPath, args: [fixture], cwd: root });
      try {
        await client.initialize();
        const service = new AcpAgentService({
          catId: 'opus',
          projectRoot: root,
          mcpSupport: false,
          providerName,
          poolKey: {},
          pool: {
            async acquire() {
              return { client, release() {} };
            },
          },
        });
        const messages = [];
        for await (const message of service.invoke('fixture', { workingDirectory: root })) messages.push(message);
        const error = messages.find((message) => message.type === 'error');
        assert.equal(error.errorCode, 'prompt_failure');
        assert.equal(error.metadata.cliDiagnostics.reasonCode, undefined);
        const excerpt = error.metadata.cliDiagnostics.safeExcerpt;
        assert.match(excerpt, /previous benign context/);
        assert.match(excerpt, /\[PEM_REDACTED\]/);
        for (const secret of secretLines) {
          assert.ok(!JSON.stringify(messages).includes(secret), 'private-key body leaked in a delivered event');
        }
        assert.doesNotMatch(error.error, /BEGIN|previous benign context/);
        assert.equal(messages.filter((message) => message.type === 'error').length, 1);
      } finally {
        await client.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
