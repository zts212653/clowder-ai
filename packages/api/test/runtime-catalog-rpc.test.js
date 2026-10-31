import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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

function running(pid) {
  try {
    process.kill(pid, 0);
    // Orphaned processes can be zombies until the host's init reaps them.
    return process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

test('a protocol error closes discovery without waiting for the deadline or the caller', async () => {
  const script = `
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const msg=JSON.parse(line);
      console.log(JSON.stringify(msg.method==='ready' ? {id:msg.id,result:{pid:process.pid}} :
        {id:msg.id,error:{message:'private-token'}}));
    });`;
  const rpc = catalogRpc(process.execPath, ['-e', script], process.cwd(), 8000);
  try {
    const owned = await rpc.request('ready', {});
    await assert.rejects(rpc.request('model/list', {}), { message: 'catalog_unavailable' });
    const deadline = Date.now() + 2500;
    while (running(owned.pid) && Date.now() < deadline) await delay(25);
    assert.equal(running(owned.pid), false, 'protocol error must start automatic cleanup');
  } finally {
    await rpc.close();
  }
});

const treeScript = `
  const {spawn}=require('node:child_process');
  const input=require('node:readline').createInterface({input:process.stdin});
  const worker=spawn(process.execPath,['-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');"
  ],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  const ready=new Promise(resolve=>worker.once('message',()=>{
    worker.disconnect(); worker.unref();
    resolve();
  }));
  // Register immediately: readline emits early requests while the worker is starting.
  input.on('line',async line=>{
    await ready;
    const msg=JSON.parse(line);
    if(msg.method==='ready') console.log(JSON.stringify({id:msg.id,result:{pid:process.pid,worker:worker.pid}}));
    else if(msg.method==='exit') process.exit(0);
    else if(msg.method==='error') console.log(JSON.stringify({id:msg.id,error:{message:'private-token'}}));
    else if(msg.method==='malformed') console.log('invalid-json-private-token');
    else if(msg.method==='overflow') process.stdout.write('x'.repeat(4000010));
  });`;

for (const mode of ['close', 'timeout', 'exit', 'error', 'malformed', 'overflow']) {
  test(
    `POSIX discovery reaps its detached worker after ${mode}, retaining unrelated processes`,
    {
      skip: process.platform === 'win32',
      timeout: 15_000,
    },
    async () => {
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      const rpc = catalogRpc(process.execPath, ['-e', treeScript], process.cwd(), mode === 'timeout' ? 1500 : 8000);
      let owned;
      try {
        owned = await rpc.request('ready', {});
        assert.ok(running(owned.worker));
        if (mode === 'close') {
          await rpc.close();
        } else {
          await assert.rejects(rpc.request(mode, {}), { message: 'catalog_unavailable' });
          // Failure paths must trigger cleanup without a cooperating caller.
        }
        const deadline = Date.now() + 3000;
        while ((running(owned.pid) || running(owned.worker)) && Date.now() < deadline) await delay(25);
        assert.equal(running(owned.pid), false, 'the owned protocol process must terminate');
        assert.equal(running(owned.worker), false, 'detached SIGTERM-resistant worker must be reaped');
        assert.ok(running(unrelated.pid), 'unrelated process must remain alive');
        await rpc.close();
      } finally {
        await rpc.close();
        for (const pid of [owned?.pid, owned?.worker, unrelated.pid]) {
          if (pid && running(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );
}
