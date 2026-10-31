import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';

const settings = {
  kind: 'settings',
  status: 'available',
  values: {
    dutyCatProfileId: 'duty',
    skin: 'yarn-ball',
    ballSize: 72,
    behaviorEnabled: true,
    proactivePolicy: 'ambient',
    personaTone: 'plain',
    householdReadsAllowed: false,
  },
  companions: [{ catProfileId: 'duty', displayName: 'Duty', available: true }],
  selectedCompanionStatus: 'available',
} as const;

for (const contract of ['0.1.0-beta.21', '0.1.0-beta.23', '0.1.0-beta.24'] as const) {
  test(`the actual child pipe carries ${contract} and uses its command/reply validator`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f317-abi-executor-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entrypoint = join(root, 'kernel.mjs');
    await writeFile(
      entrypoint,
      `
      import { createInterface } from 'node:readline';
      let resolveReply;
      const received = new Promise(resolve => { resolveReply = resolve; });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      createInterface({ input: process.stdin }).on('line', async line => {
        const message = JSON.parse(line);
        if (message.type === 'companion') { resolveReply(message.reply); return; }
        if (message.method === 'open') {
          if (message.params.companionContract !== ${JSON.stringify(contract)} || message.params.publicCompanionV2 !== true) process.exit(3);
          send({v:1,id:message.id,ok:true,value:null});
          send({v:1,type:'companion',id:'2acd3aa4-5d1a-4826-b7b4-39865266b5f2',command:{kind:'settings.read'}});
        } else if (message.method === 'poll') {
          const reply = await received;
          const expected = ${JSON.stringify(contract)} !== '0.1.0-beta.21'
            ? reply.kind === 'settings' && reply.status === 'available' && reply.values.behaviorEnabled === true
            : reply.kind === 'error' && reply.code === 'invalid_request';
          send({v:1,id:message.id,ok:true,value:expected ? 'visible' : 'invalid'});
        } else { send({v:1,id:message.id,ok:true,value:null}); }
      });
    `,
    );
    const executor = new ElectronDesktopWindowExecutor({ executable: process.execPath, entrypoint });
    let effects = 0;
    const window = await executor.open({
      url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/renderer/index.html`,
      presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true },
      publicCompanionV2: true,
      companionContract: contract,
      signal: new AbortController().signal,
      onClosed() {},
      request: async () => {
        effects++;
        return settings;
      },
    });
    t.after(() => window.close());
    assert.equal(await window.poll(), 'visible');
    assert.equal(
      effects,
      contract !== '0.1.0-beta.21' ? 1 : 0,
      'legacy denial happens before the Host handler; the selected modern reply reaches its own child',
    );
  });
}

test(
  'the actual desktop close waits for TERM-resistant members of its owned child group',
  {
    skip: process.platform === 'win32',
    timeout: 5_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f317-desktop-close-group-'));
    const entrypoint = join(root, 'kernel.mjs');
    const identity = join(root, 'owned-processes.json');
    t.after(() => rm(root, { recursive: true, force: true }));
    const descendant =
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000);";
    await writeFile(
      entrypoint,
      `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','pipe','ignore']});
    const ready = new Promise(resolve => child.stdout.once('data', () => {
      writeFileSync(${JSON.stringify(identity)}, JSON.stringify({root:process.pid,descendant:child.pid}));
      resolve();
    }));
    createInterface({input:process.stdin}).on('line', async line => {
      const message = JSON.parse(line);
      await ready;
      process.stdout.write(JSON.stringify({v:1,id:message.id,ok:true,value:null})+'\\n', () => {
        if (message.method === 'close') process.exit(0);
      });
    });
  `,
    );
    const executor = new ElectronDesktopWindowExecutor({ executable: process.execPath, entrypoint });
    const window = await executor.open({
      url: `http://companion-${'b'.repeat(32)}.localhost:4187/packages/fixture/renderer/index.html`,
      presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true },
      publicCompanionV2: true,
      companionContract: '0.1.0-beta.23',
      signal: new AbortController().signal,
      onClosed() {},
    });
    const pids: { root: number; descendant: number } = JSON.parse(await readFile(identity, 'utf8'));
    t.after(() => {
      try {
        process.kill(-pids.root, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    });
    await window.close();
    assert.throws(() => process.kill(pids.descendant, 0), { code: 'ESRCH' });
  },
);
