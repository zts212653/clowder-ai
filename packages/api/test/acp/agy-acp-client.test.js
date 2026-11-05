import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import {
  createAgyAcpPermissionHandler,
  denyAgyAcpPermission,
} from '../../dist/domains/cats/services/agents/providers/acp/agy/agy-acp-permission.js';

function fixture(extra = {}) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.stdout.end();
      child.stderr.end();
      emitter.emit('exit', 0);
    },
  });
  const requests = [];
  let spawnOptions;
  const respond = (id, result) =>
    setImmediate(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
  child.stdin.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      requests.push(message);
      if (message.method === 'initialize')
        respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: 'antigravity', version: '1.4.0' },
        });
      else if (message.method === 'authenticate') respond(message.id, {});
      else if (['session/new', 'session/load', 'session/resume'].includes(message.method))
        respond(message.id, message.method === 'session/new' ? { sessionId: 'session' } : {});
    }
  });
  const client = new AcpClient({
    command: 'mock',
    args: [],
    cwd: '/tmp',
    spawnFn: (_c, _a, options) => {
      spawnOptions = options;
      return child;
    },
    ...extra,
  });
  return {
    client,
    child,
    requests,
    respond,
    get spawnOptions() {
      return spawnOptions;
    },
  };
}

test('ACP native metadata is sent unchanged on new/load/resume, with original resume id', async () => {
  const f = fixture();
  try {
    await f.client.initialize();
    const meta = { antigravity: { systemPrompt: { append: 'L0' } } };
    await f.client.newSession('/tmp', [], meta);
    await f.client.loadSession('original', '/tmp', [], meta);
    assert.equal((await f.client.resumeSession('original', '/tmp', [], meta)).sessionId, 'original');
    for (const request of f.requests.filter((r) => r.method.startsWith('session/')))
      assert.deepEqual(request.params._meta, meta);
  } finally {
    await f.client.close();
  }
});

test('explicit personal login sends authentication only, without creating a session or model turn', async () => {
  const f = fixture();
  try {
    await f.client.initialize();
    await f.client.authenticate('oauth-personal');
    assert.deepEqual(
      f.requests.map((request) => request.method),
      ['initialize', 'authenticate'],
    );
    assert.equal(f.requests[1].params.methodId, 'oauth-personal');
  } finally {
    await f.client.close();
  }
});

test('isolated ACP spawn does not inherit an ambient API key or invocation token', async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-ambient';
  const f = fixture({ inheritParentEnv: false, env: { HOME: '/tmp/isolated', PATH: process.env.PATH } });
  try {
    await f.client.initialize();
    assert.equal(f.spawnOptions.env.GEMINI_API_KEY, undefined);
    assert.equal(f.spawnOptions.env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  } finally {
    await f.client.close();
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test('ACP refuses a second same-session prompt before writing it', async () => {
  const f = fixture({ permissionHandler: denyAgyAcpPermission });
  try {
    await f.client.initialize();
    const stream = f.client.promptStream('session', 'A', { timeoutMs: 0, idleStallMs: 0 });
    const first = stream.next();
    await new Promise((resolve) => setImmediate(resolve));
    const second = f.client.promptStream('session', 'B', { timeoutMs: 0, idleStallMs: 0 });
    // Bound the RED run too: without the guard, settle B then A so the test cannot hang.
    const next = second.next();
    next.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    for (const request of f.requests.filter((r) => r.method === 'session/prompt'))
      f.respond(request.id, { stopReason: 'end_turn' });
    await assert.rejects(next, /active|concurrent/i);
    await first;
    await stream.return();
    assert.equal(f.requests.filter((r) => r.method === 'session/prompt').length, 1);
  } finally {
    await f.client.close();
  }
});

test('AGY session-scoped provider diagnostic fails a text plus end_turn response without guessing from prose', async () => {
  const f = fixture({ antigravityDiagnostics: true });
  try {
    await f.client.initialize();
    const stream = f.client.promptStream('session', 'work', { timeoutMs: 0, idleStallMs: 0 });
    const result = stream.next();
    result.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    f.child.stderr.write('ERROR server.py: Antigravity SDK error processing prompt for ses');
    f.child.stderr.write('sion session\n');
    f.respond(f.requests.find((request) => request.method === 'session/prompt').id, { stopReason: 'end_turn' });
    await assert.rejects(result, /provider execution failed/);
  } finally {
    await f.client.close();
  }
});

test('AGY permission rejects unknown sessions, malformed operations, and stale invocation', async () => {
  const input = {
    sessionId: 'session',
    workspace: '/tmp',
    profileHome: '/tmp/profile',
    autoApprove: true,
    readOnly: false,
    mcpServers: ['cat-cafe-memory'],
    isActive: () => true,
  };
  const request = {
    params: {
      sessionId: 'session',
      options: [
        { kind: 'allow_once', optionId: 'yes' },
        { kind: 'reject_once', optionId: 'no' },
      ],
      toolCall: { title: 'unrecognized', kind: 'other', rawInput: {} },
    },
  };
  const decision = async (req, opts = input) => {
    let response;
    await createAgyAcpPermissionHandler(opts)(req, (value) => {
      response = value;
    });
    return response;
  };
  assert.deepEqual(await decision(request), { optionId: 'no' });
  const mcp = {
    ...request,
    params: {
      ...request.params,
      toolCall: {
        ...request.params.toolCall,
        _meta: { mcp: { server: 'cat-cafe-memory', tool: 'cat_cafe_search_evidence' } },
      },
    },
  };
  assert.deepEqual(await decision(mcp), { optionId: 'yes' });
  assert.deepEqual(await decision(mcp, { ...input, isActive: () => false }), { optionId: 'no' });
  assert.deepEqual(await decision({ ...mcp, params: { ...mcp.params, sessionId: 'other' } }), { optionId: 'no' });
  assert.deepEqual(await decision(mcp, { ...input, readOnly: true }), { optionId: 'no' });
});

test('AGY permission normalizes documented file aliases and rejects conflicting targets', async () => {
  const decide = async (rawInput) => {
    let response;
    await createAgyAcpPermissionHandler({
      sessionId: 's',
      workspace: '/tmp',
      profileHome: '/tmp/profile',
      autoApprove: true,
      readOnly: false,
      mcpServers: [],
      isActive: () => true,
    })(
      {
        params: {
          sessionId: 's',
          toolCall: { title: 'write_file', kind: 'edit', rawInput },
          options: [
            { kind: 'allow_once', optionId: 'yes' },
            { kind: 'reject_once', optionId: 'no' },
          ],
        },
      },
      (value) => {
        response = value;
      },
    );
    return response;
  };
  for (const key of ['TargetFile', 'target_file', 'FilePath', 'file_path', 'AbsolutePath', 'absolute_path', 'path'])
    assert.deepEqual(await decide({ [key]: '/tmp/f325-permission.md' }), { optionId: 'yes' });
  assert.deepEqual(await decide({ FilePath: '/tmp/profile/.gemini/antigravity-acp/acp_token.json' }), {
    optionId: 'no',
  });
  assert.deepEqual(await decide({ TargetFile: '/tmp/f325-permission.md', FilePath: '/tmp/other.md' }), {
    optionId: 'no',
  });
});
