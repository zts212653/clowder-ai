import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogRpc } from '../dist/routes/runtime-catalog-rpc.js';

test('discovery rejects agent tool requests and closes only its owned child', async () => {
  const script = `
    const readline=require('node:readline');
    const input=readline.createInterface({input:process.stdin});
    let request;
    input.on('line',line=>{
      const msg=JSON.parse(line);
      if(msg.method){ request=msg; console.log(JSON.stringify({jsonrpc:'2.0',id:99,method:'fs/read_text_file',params:{path:'private'}})); }
      else if(msg.id===99) console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{pid:process.pid,denied:msg.error.code}}));
    });`;
  const rpc = catalogRpc(process.execPath, ['-e', script], process.cwd());
  const value = await rpc.request('model/list', {});
  assert.equal(value.denied, -32601);
  await rpc.close();
  await rpc.close();
  assert.throws(() => process.kill(value.pid, 0));
});
test('a hung discovery is bounded and pending calls reject without leaking provider output', async () => {
  const rpc = catalogRpc(
    process.execPath,
    ['-e', "process.stdin.resume();console.error('private-token');"],
    process.cwd(),
    100,
  );
  try {
    await assert.rejects(rpc.request('model/list', {}), { message: 'catalog_unavailable' });
  } finally {
    await rpc.close();
  }
});
