import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PiRpcProcess } from '../dist/domains/cats/services/agents/providers/pi/pi-rpc-process.js';

test('Pi owns child stdin errors and reclaims the process instead of emitting an uncaught EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-rpc-broken-stdin-'));
  const fake = join(root, 'fake.mjs');
  writeFileSync(
    fake,
    String.raw`let b='';process.stdin.on('data',c=>{b+=c;const i=b.indexOf('\n');if(i<0)return;const q=JSON.parse(b.slice(0,i));process.stdout.write(JSON.stringify({type:'response',id:q.id,success:true,data:{}})+'\n');process.stdin.destroy();});setInterval(()=>{},1000);`,
  );
  const rpc = new PiRpcProcess(process.execPath, [fake], root);
  try {
    await rpc.request('get_state');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(rpc.request('prompt', { message: 'x'.repeat(100_000) }, 1_000));
  } finally {
    await rpc.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
