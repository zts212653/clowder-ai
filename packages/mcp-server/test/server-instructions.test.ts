import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAudioServer } from '../src/audio.js';
import { createCollabServer } from '../src/collab.js';
import { createFinanceServer } from '../src/finance.js';
import { createLimbServer } from '../src/limb.js';
import { createMemoryServer } from '../src/memory.js';
import { SERVER_INSTRUCTIONS } from '../src/server-instructions.js';
import { createSignalsServer } from '../src/signals.js';

const servers = [
  ['collab', createCollabServer],
  ['memory', createMemoryServer],
  ['signals', createSignalsServer],
  ['limb', createLimbServer],
  ['audio', createAudioServer],
  ['finance', createFinanceServer],
] as const;

describe('F286 provider-native server discovery instructions', () => {
  for (const [family, createServer] of servers) {
    it(`${family} publishes bounded, self-contained initialize instructions`, async () => {
      const instruction = SERVER_INSTRUCTIONS[family];
      assert.ok(instruction);
      assert.ok(instruction.indexOf('.') > 20, 'first sentence must be a meaningful retrieval index');
      assert.ok(Buffer.byteLength(instruction, 'utf8') <= 2_000);
      assert.doesNotMatch(instruction, /credential|token|password|current user|current project/i);

      const server = createServer();
      const client = new Client({ name: `f286-${family}-instructions`, version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        assert.equal(client.getInstructions(), instruction);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
