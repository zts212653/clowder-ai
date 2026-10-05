import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { getCliExecutionExit } from '../dist/utils/CliExecutionObservation.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

test('CodexAgentService direct production factory binds audit scope to a real per-invocation child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue1371-codex-direct-'));
  const command = join(directory, 'fixture-codex.cjs');
  const owner = {
    executionId: randomUUID(),
    invocationId: randomUUID(),
    threadId: randomUUID(),
    userId: 'fixture-user',
    catId: 'codex-sol',
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',(line)=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'fixture'}});
  else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'provider-thread',turns:[]}}});
  else if(m.method==='turn/start') {
    send({id:m.id,result:{turn:{id:'provider-turn',status:'inProgress',items:[]}}});
    setImmediate(()=>send({method:'turn/completed',params:{threadId:'provider-thread',turn:{id:'provider-turn',status:'completed',items:[]}}}));
  }
});
rl.on('close',()=>process.exit(0));
`,
    { mode: 0o755 },
  );
  try {
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: command,
      model: 'gpt-5.6-sol',
      l0CompilerFn: fakeL0Compiler,
      rawArchive: { append: async () => {} },
    });
    const events = [];
    for await (const event of service.invoke('fixture only', {
      invocationId: owner.invocationId,
      auditContext: owner,
      workingDirectory: directory,
      callbackEnv: { CAT_CAFE_DATA_DIR: directory },
    }))
      events.push(event);
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      [],
    );
    assert.ok(events.some((event) => event.type === 'done'));
    assert.ok(
      getCliExecutionExit(owner)?.exitedAt,
      'the production factory must carry the exact server-owned coordinates',
    );
    assert.equal(getCliExecutionExit({ ...owner, executionId: 'other-parent' }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
