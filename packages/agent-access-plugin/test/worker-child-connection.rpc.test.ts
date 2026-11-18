import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Readable } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import { attachWorkerChildConnection, type WorkerAcpChildHandle } from '../src/runtime/acp/worker-child-connection.ts';
import { ExecutionRpcPeer } from '../../api/src/domains/plugin/execution-worker/rpc-peer.ts';
import { RetainedRemoteValue } from '../../api/src/domains/plugin/execution-worker/protocol.ts';

/**
 * Cross-boundary checks against the real execution RPC, not a fake: two in-process
 * peers joined by a MessageChannel stand in for Host and plugin.
 *
 * What these tests establish about the Host contract this module depends on:
 *
 *   - handle fields (pid) and Readable pipes cross the boundary intact;
 *   - a launch reply registers its callables in the `retained` scope, and that scope
 *     survives the reply it came from, so writes keep reaching the Host across turns.
 */
function hostAndPlugin() {
  const { port1, port2 } = new MessageChannel();
  const host = new ExecutionRpcPeer(port1);
  const plugin = new ExecutionRpcPeer(port2);
  return { host, plugin };
}

function hostHandle() {
  const writes = [];
  const handle = {
    pid: 9191,
    stdout: Readable.from(['{"jsonrpc":"2.0"}\n']),
    stderr: Readable.from([]),
    isWritable: () => true,
    isKilled: () => false,
    write: (line) => {
      writes.push(line);
    },
    termination: () => new Promise(() => {}),
    shutdown: async () => {},
  };
  return { handle, writes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('attachWorkerChildConnection over the real execution RPC', () => {
  test('handle fields and Readable pipes cross the boundary intact', async (t) => {
    const { host, plugin } = hostAndPlugin();
    t.after(() => {
      host.close();
      plugin.close();
    });

    const fake = hostHandle();
    host.expose('acp.launch', () => fake.handle);

    const connection = await attachWorkerChildConnection(
      async () => plugin.call('acp.launch', []) as Promise<WorkerAcpChildHandle>,
    );

    assert.equal(connection.pid, 9191);
    assert.equal(connection.isWritable(), true);
    assert.equal(connection.isKilled(), false);

    const chunks = [];
    for await (const chunk of connection.stdout) chunks.push(String(chunk));
    assert.deepEqual(chunks, ['{"jsonrpc":"2.0"}\n'], 'the Host stdout stream arrives transferable and complete');
  });

  test('a retained-scope reply keeps its callables while the reply pipes are open', async (t) => {
    const { host, plugin } = hostAndPlugin();
    t.after(() => {
      host.close();
      plugin.close();
    });

    const fake = hostHandle();
    host.expose('acp.launch', () => new RetainedRemoteValue(fake.handle));

    const connection = await attachWorkerChildConnection(
      async () => plugin.call('acp.launch', []) as Promise<WorkerAcpChildHandle>,
    );

    assert.equal(connection.pid, 9191, 'the handle fields cross intact');
    assert.equal(connection.isWritable(), true);

    connection.write('hello\n');
    await settle();
    assert.deepEqual(fake.writes, ['hello\n'], 'while the reply is still alive, writes reach the Host');
  });
});
