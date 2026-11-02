import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PiAcpEvents } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-events.js';
import { PiRpcProcess } from '../dist/domains/cats/services/agents/providers/pi/pi-rpc-process.js';

test('RPC rejection and assistant errors suppress incomplete, wrapped and oversized PEM', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const body = pem
    .split('\n')
    .slice(1, -2)
    .join('')
    .match(/.{1,16}/g);
  const root = mkdtempSync(join(tmpdir(), 'pi-rpc-pem-'));
  const fake = join(root, 'rpc.mjs');
  writeFileSync(
    fake,
    `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:q.id,success:false,error:q.error})+'\\n');});`,
  );
  const rpc = new PiRpcProcess(process.execPath, [fake], root);
  try {
    for (const complete of [false, true]) {
      for (const oversized of [false, true]) {
        const error = `provider failed\n${oversized ? 'x'.repeat(20000) : ''}-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n${complete ? '-----END PRIVATE KEY-----\n' : ''}`;
        await assert.rejects(rpc.request('probe', { error }), (failure) => {
          assert.equal(
            body.some((line) => failure.message.includes(line)),
            false,
            'RPC must not expose PEM body',
          );
          return true;
        });
        const events = new PiAcpEvents(() => {});
        events.accept({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: error },
        });
        assert.equal(
          body.some((line) => events.failure.message.includes(line)),
          false,
          'assistant error must not expose PEM body',
        );
      }
    }
  } finally {
    await rpc.close();
  }
});
