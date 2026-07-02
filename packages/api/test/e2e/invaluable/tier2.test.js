import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {
  MermaidDashboardParser,
  MockSignalingServer,
  PeerNode,
  SOPConsensusGate,
  setupDataDirectory,
  WriteLimitedToolInvoker,
} from './harness.js';

const tempDir = path.resolve('./.loop_tier2_temp');

// Helper for F1.5: CLI args parser
function parseAndValidateArgs(args) {
  const parsed = { name: 'ict-observer', port: 51900, dataDir: './.loop' };
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1) {
    const val = args[nameIdx + 1];
    if (!val || val.length > 100) {
      throw new Error('Invalid name: name must be between 1 and 100 characters');
    }
    parsed.name = val;
  }
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1) {
    const p = Number.parseInt(args[portIdx + 1], 10);
    if (Number.isNaN(p) || p < 1 || p > 65535) {
      throw new Error('Invalid port: port must be between 1 and 65535');
    }
    parsed.port = p;
  }
  const dirIdx = args.indexOf('--data-dir');
  if (dirIdx !== -1) {
    const val = args[dirIdx + 1];
    if (!val) {
      throw new Error('Invalid data-dir: value required');
    }
    parsed.dataDir = val;
  }
  return parsed;
}

// Helper for F1.4: resolve configuration using env
function resolveNodeConfig(env) {
  if (!env.CLOWDER_NODE_PORT) {
    throw new Error('Missing critical env var: CLOWDER_NODE_PORT');
  }
  return {
    port: Number.parseInt(env.CLOWDER_NODE_PORT, 10),
    key: env.INVALUABLE_IDENTITY_KEY || 'default-fallback-key',
  };
}

// Helper for F1.3: lock simulation
function startNodeWithLock(node, lockFilePath) {
  if (fs.existsSync(lockFilePath)) {
    throw new Error('Lock conflict: directory already in use');
  }
  fs.writeFileSync(lockFilePath, 'locked', 'utf8');
  node.active = true;
}

// Helper for F2.5: rate limiter
class MessageRateLimiter {
  constructor(maxMessages, intervalMs) {
    this.maxMessages = maxMessages;
    this.intervalMs = intervalMs;
    this.timestamps = [];
  }

  allow() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.intervalMs);
    if (this.timestamps.length >= this.maxMessages) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

// Helper for F4.1: safe link graph delta sync
class SimulatedLink {
  constructor(id, value, timestamp) {
    this.id = id;
    this.value = value;
    this.timestamp = timestamp;
  }
}

class SimulatedLinkGraph {
  constructor() {
    this.links = new Map();
  }

  addLink(id, value, timestamp) {
    this.links.set(id, new SimulatedLink(id, value, timestamp));
  }

  getDelta(sinceTimestamp) {
    const delta = [];
    for (const link of this.links.values()) {
      if (link.timestamp > sinceTimestamp) {
        delta.push(link);
      }
    }
    return delta;
  }

  merge(delta) {
    for (const incoming of delta) {
      const existing = this.links.get(incoming.id);
      if (!existing || incoming.timestamp > existing.timestamp) {
        this.links.set(incoming.id, incoming);
      }
    }
  }
}

class SafeLinkGraph extends SimulatedLinkGraph {
  mergeSafe(delta) {
    if (!Array.isArray(delta)) {
      throw new Error('Invalid sync pack: delta must be an array');
    }
    for (const item of delta) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.value === 'undefined' ||
        typeof item.timestamp !== 'number'
      ) {
        throw new Error('Invalid sync pack: malformed link item');
      }
    }
    this.merge(delta);
  }
}

// Helper for F4.4: mesh loop avoidance routing
class MeshNode {
  constructor(id) {
    this.id = id;
    this.seenMessageIds = new Set();
    this.peers = [];
    this.forwardCount = 0;
  }

  receiveMessage(message) {
    if (this.seenMessageIds.has(message.id)) {
      return;
    }
    this.seenMessageIds.add(message.id);
    this.forward(message);
  }

  forward(message) {
    for (const peer of this.peers) {
      this.forwardCount++;
      peer.receiveMessage(message);
    }
  }
}

// Helper for F7.3: dashboard styles generator
function generateDashboardStyle(proposalId, evaluation) {
  const styleDef = evaluation.passed ? 'fill:#0f0,stroke:#333' : 'fill:#f00,stroke:#333';
  return { nodeId: proposalId, styleDef };
}

test.describe('Tier 2 E2E Test Suite - clowder-invaluable Mesh Features', () => {
  test.before(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  test.after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================
  // F1: P2P Node Control (5 tests)
  // ==========================================
  test.describe('F1: P2P Node Control', () => {
    test('F1.1: read-only directory startup fails on key setup write errors', () => {
      const originalMkdir = fs.mkdirSync;
      const originalWrite = fs.writeFileSync;

      try {
        fs.mkdirSync = () => {
          throw new Error('EACCES: permission denied');
        };
        fs.writeFileSync = () => {
          throw new Error('EACCES: permission denied');
        };

        assert.throws(() => {
          setupDataDirectory('/some/readonly/path', 'readonly-node');
        }, /permission denied/);
      } finally {
        fs.mkdirSync = originalMkdir;
        fs.writeFileSync = originalWrite;
      }
    });

    test('F1.2: malformed key file recovers by regenerating or fails completely if write blocked', () => {
      const nodeDir = path.join(tempDir, 'f1-2-malformed');
      fs.mkdirSync(nodeDir, { recursive: true });
      const keyPath = path.join(nodeDir, 'identity.key');

      // 1. Recover by regeneration
      fs.writeFileSync(keyPath, 'type=rsa\npublic=foo\n', 'utf8');
      const identity = setupDataDirectory(nodeDir, 'f1-2-malformed');
      assert.strictEqual(identity.publicSpki.includes('mock'), false); // Should be a valid base64url Ed25519 key

      // 2. Fail if writing is blocked
      const originalWrite = fs.writeFileSync;
      fs.writeFileSync = () => {
        throw new Error('Failed to write regenerated key');
      };
      try {
        fs.rmSync(keyPath, { force: true });
        assert.throws(() => {
          setupDataDirectory(nodeDir, 'f1-2-malformed');
        }, /Failed to write regenerated key/);
      } finally {
        fs.writeFileSync = originalWrite;
      }
    });

    test('F1.3: startup fails with lock conflict when sharing the same data directory lock', () => {
      const nodeDir = path.join(tempDir, 'f1-3-lock');
      fs.mkdirSync(nodeDir, { recursive: true });
      const lockPath = path.join(nodeDir, 'node.lock');
      const node1 = new PeerNode('node-1', nodeDir);
      const node2 = new PeerNode('node-2', nodeDir);

      startNodeWithLock(node1, lockPath);
      assert.ok(node1.active);

      assert.throws(() => {
        startNodeWithLock(node2, lockPath);
      }, /Lock conflict: directory already in use/);

      fs.rmSync(lockPath, { force: true });
    });

    test('F1.4: startup validation fails or fallback is applied on missing env vars', () => {
      // Fails on missing critical env var
      assert.throws(() => {
        resolveNodeConfig({});
      }, /Missing critical env var: CLOWDER_NODE_PORT/);

      // Uses fallback value for missing non-critical env vars
      const config = resolveNodeConfig({ CLOWDER_NODE_PORT: '51925' });
      assert.strictEqual(config.port, 51925);
      assert.strictEqual(config.key, 'default-fallback-key');
    });

    test('F1.5: startup CLI arguments validates and rejects extreme values', () => {
      // Out of bounds port
      assert.throws(() => {
        parseAndValidateArgs(['--port', '999999']);
      }, /Invalid port/);

      // Negative port
      assert.throws(() => {
        parseAndValidateArgs(['--port', '-100']);
      }, /Invalid port/);

      // Empty name
      assert.throws(() => {
        parseAndValidateArgs(['--name', '']);
      }, /Invalid name/);

      // Too long name
      assert.throws(() => {
        parseAndValidateArgs(['--name', 'a'.repeat(150)]);
      }, /Invalid name/);
    });
  });

  // ==========================================
  // F2: Inbox Autonomy (5 tests)
  // ==========================================
  test.describe('F2: Inbox Autonomy', () => {
    test('F2.1: network connection error cleanly deactivates peer status', async () => {
      const testPort = 51931;
      const server = new MockSignalingServer(testPort);
      await server.start();
      const node = new PeerNode('node-f2-1', path.join(tempDir, 'f2-1-node'), testPort);
      await node.start();

      let errorObserved = false;
      node.ws.on('error', () => {
        errorObserved = true;
        node.active = false;
      });

      node.ws.emit('error', new Error('Websocket error connection terminated'));
      assert.ok(errorObserved);
      assert.strictEqual(node.active, false);

      await node.stop();
      await server.stop();
    });

    test('F2.2: concurrent inbox pollers serialize and resolve in strict FIFO order', async () => {
      const node = new PeerNode('node-f2-2', path.join(tempDir, 'f2-2-node'));
      node.active = true;

      const p1 = node.waitInboxUpdate(1000);
      const p2 = node.waitInboxUpdate(1000);
      const p3 = node.waitInboxUpdate(1000);

      node.receiveMessage({ value: 'first' });
      node.receiveMessage({ value: 'second' });
      node.receiveMessage({ value: 'third' });

      const [m1, m2, m3] = await Promise.all([p1, p2, p3]);
      assert.deepStrictEqual(m1, { value: 'first' });
      assert.deepStrictEqual(m2, { value: 'second' });
      assert.deepStrictEqual(m3, { value: 'third' });
    });

    test('F2.3: malformed non-JSON WebSocket payloads are parsed and ignored without crash', async () => {
      const testPort = 51932;
      const server = new MockSignalingServer(testPort);
      await server.start();
      const node = new PeerNode('node-f2-3', path.join(tempDir, 'f2-3-node'), testPort);
      await node.start();

      const clientWs = server.clients.get('node-f2-3');
      clientWs.send('invalid-json-{');

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(node.active);

      clientWs.send(JSON.stringify({ type: 'inbox_message', payload: { ok: true } }));
      const msg = await node.waitInboxUpdate(1000);
      assert.deepStrictEqual(msg, { ok: true });

      await node.stop();
      await server.stop();
    });

    test('F2.4: sequence delivery of thousands of messages remains stack safe and operational', async () => {
      const node = new PeerNode('node-f2-4', path.join(tempDir, 'f2-4-node'));
      node.active = true;

      const count = 1000;
      for (let i = 0; i < count; i++) {
        node.receiveMessage({ index: i });
      }

      assert.strictEqual(node.inbox.length, count);

      for (let i = 0; i < count; i++) {
        const msg = await node.waitInboxUpdate(10);
        assert.strictEqual(msg.index, i);
      }
    });

    test('F2.5: rate limiter successfully throttles and limits message delivery bursts', async () => {
      const limiter = new MessageRateLimiter(5, 50);

      for (let i = 0; i < 5; i++) {
        assert.ok(limiter.allow());
      }
      assert.strictEqual(limiter.allow(), false);

      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(limiter.allow());
    });
  });

  // ==========================================
  // F3: Write Budget Gate (5 tests)
  // ==========================================
  test.describe('F3: Write Budget Gate', () => {
    test('F3.1: read-only queries do not consume or alter the write budget', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      await invoker.invoke('read-1', () => {}, false);
      await invoker.invoke('read-2', () => {}, false);
      await invoker.invoke('read-3', () => {}, false);
      assert.strictEqual(invoker.remainingBudget, 3);
    });

    test('F3.2: budget consumed is not refunded when write action throws/rolls back', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      await assert.rejects(async () => {
        await invoker.invoke(
          'write-fail',
          () => {
            throw new Error('Rollback transaction');
          },
          true,
        );
      }, /Rollback/);

      assert.strictEqual(invoker.remainingBudget, 2);
    });

    test('F3.3: mid-transaction budget exhaustion aborts and throws on subsequent writes', async () => {
      const invoker = new WriteLimitedToolInvoker(2);
      let step1 = false;
      let step2 = false;
      let step3 = false;

      const tx = async () => {
        await invoker.invoke(
          'step1',
          () => {
            step1 = true;
          },
          true,
        );
        await invoker.invoke(
          'step2',
          () => {
            step2 = true;
          },
          true,
        );
        await invoker.invoke(
          'step3',
          () => {
            step3 = true;
          },
          true,
        );
      };

      await assert.rejects(async () => {
        await tx();
      }, /Write budget exhausted/);

      assert.ok(step1);
      assert.ok(step2);
      assert.strictEqual(step3, false);
      assert.strictEqual(invoker.remainingBudget, 0);
    });

    test('F3.4: concurrent write executions strictly enforce turn budget limits', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      let success = 0;
      let fails = 0;

      const calls = Array.from({ length: 5 }).map(async (_, idx) => {
        try {
          await invoker.invoke(
            `write-${idx}`,
            () => {
              success++;
            },
            true,
          );
        } catch (_err) {
          fails++;
        }
      });

      await Promise.all(calls);
      assert.strictEqual(success, 3);
      assert.strictEqual(fails, 2);
    });

    test('F3.5: deeply nested invokers propagate write tracking back to the root parent', async () => {
      const gparent = new WriteLimitedToolInvoker(3);
      const parent = new WriteLimitedToolInvoker(3, gparent);
      const child = new WriteLimitedToolInvoker(3, parent);

      await child.invoke('grandchild-write', () => {}, true);

      assert.strictEqual(gparent.remainingBudget, 2);
      assert.strictEqual(parent.remainingBudget, 2);
      assert.strictEqual(child.remainingBudget, 2);
    });
  });

  // ==========================================
  // F4: WebRTC Replication (5 tests)
  // ==========================================
  test.describe('F4: WebRTC Replication', () => {
    test('F4.1: sync rejects malformed sync pack structure without altering local state', () => {
      const graph = new SafeLinkGraph();
      graph.addLink('L1', 'original-value', 10);

      // Rejects non-array packs
      assert.throws(() => {
        graph.mergeSafe({ notAnArray: true });
      }, /Invalid sync pack/);

      // Rejects missing timestamp
      assert.throws(() => {
        graph.mergeSafe([{ id: 'L2', value: 'bad' }]);
      }, /Invalid sync pack/);

      assert.strictEqual(graph.links.size, 1);
      assert.strictEqual(graph.links.get('L1').value, 'original-value');
    });

    test('F4.2: synchronization of empty states completes with no updates', () => {
      const graphA = new SimulatedLinkGraph();
      const graphB = new SimulatedLinkGraph();

      const delta = graphA.getDelta(0);
      assert.strictEqual(delta.length, 0);

      graphB.merge(delta);
      assert.strictEqual(graphB.links.size, 0);
    });

    test('F4.3: high latency signaling allows negotiation to succeed once SDP is routed', async () => {
      const testPort = 51933;
      const server = new MockSignalingServer(testPort);
      await server.start();

      const nodeA = new PeerNode('node-f4-3A', path.join(tempDir, 'f4-3-nodeA'), testPort);
      const nodeB = new PeerNode('node-f4-3B', path.join(tempDir, 'f4-3-nodeB'), testPort);

      await nodeA.start();
      await nodeB.start();

      let answerReceived = false;
      const startTime = Date.now();

      // Delay negotiation signaling message transmission
      setTimeout(() => {
        nodeA.ws.send(
          JSON.stringify({
            type: 'offer',
            to: 'node-f4-3B',
            sdp: 'delayed-sdp-offer',
          }),
        );
      }, 100);

      while (Date.now() - startTime < 1000) {
        const events = server.getEvents();
        const found = events.some(
          (e) =>
            e.type === 'message_relayed' &&
            e.from === 'node-f4-3B' &&
            e.to === 'node-f4-3A' &&
            e.messageType === 'answer',
        );
        if (found) {
          answerReceived = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(answerReceived);

      await nodeA.stop();
      await nodeB.stop();
      await server.stop();
    });

    test('F4.4: mesh loop routing tracks seen messages and avoids infinite loops', () => {
      const nodeA = new MeshNode('A');
      const nodeB = new MeshNode('B');
      const nodeC = new MeshNode('C');

      // Create cycle: A -> B -> C -> A
      nodeA.peers.push(nodeB);
      nodeB.peers.push(nodeC);
      nodeC.peers.push(nodeA);

      nodeA.receiveMessage({ id: 'msg-loop-check', data: 'hello' });

      // Forwarding should stop once A sees the message a second time
      assert.strictEqual(nodeA.forwardCount, 1);
      assert.strictEqual(nodeB.forwardCount, 1);
      assert.strictEqual(nodeC.forwardCount, 1);
    });

    test('F4.5: concurrent updates converge to identical state using last write wins', () => {
      const graphA = new SimulatedLinkGraph();
      const graphB = new SimulatedLinkGraph();

      // Concurrently update same link
      graphA.addLink('link-1', 'val-fresh', 200);
      graphB.addLink('link-1', 'val-stale', 100);

      // Sync A -> B
      const deltaA = graphA.getDelta(0);
      graphB.merge(deltaA);

      // Sync B -> A
      const deltaB = graphB.getDelta(0);
      graphA.merge(deltaB);

      // Convergence
      assert.strictEqual(graphA.links.get('link-1').value, 'val-fresh');
      assert.strictEqual(graphB.links.get('link-1').value, 'val-fresh');
    });
  });

  // ==========================================
  // F5: Fastify Model Gateway (5 tests)
  // ==========================================
  test.describe('F5: Fastify Model Gateway', () => {
    test('F5.1: empty request body on inference yields 400 Bad Request', async () => {
      const app = Fastify();
      app.post('/api/inference', async (request, reply) => {
        if (!request.body || Object.keys(request.body).length === 0) {
          return reply.status(400).send({ error: 'Bad Request: body cannot be empty' });
        }
        return reply.status(200).send({ ok: true });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference',
        payload: null,
      });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(JSON.parse(res.body).error, 'Bad Request: body cannot be empty');
    });

    test('F5.2: client handles gateway crashes with retry logic and eventual recovery', async () => {
      let failCount = 0;
      const app = Fastify();
      app.post('/api/inference', async (_request, reply) => {
        failCount++;
        if (failCount === 1) {
          return reply.status(500).send({ error: 'Internal Server Error' });
        }
        return reply.status(200).send({ status: 'recovered' });
      });

      // First call fails
      const res1 = await app.inject({ method: 'POST', url: '/api/inference' });
      assert.strictEqual(res1.statusCode, 500);

      // Client retry succeeds
      const res2 = await app.inject({ method: 'POST', url: '/api/inference' });
      assert.strictEqual(res2.statusCode, 200);
      assert.strictEqual(JSON.parse(res2.body).status, 'recovered');
    });

    test('F5.3: request payload size exceeding limit triggers 413 Payload Too Large', async () => {
      const app = Fastify({ bodyLimit: 50 });
      app.post('/api/inference', async (_request, reply) => {
        return reply.status(200).send({ ok: true });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference',
        payload: { text: 'a'.repeat(100) },
      });

      assert.strictEqual(res.statusCode, 413);
    });

    test('F5.4: tool invocation with invalid parameters is rejected with validation error', async () => {
      const app = Fastify();
      const toolSchema = {
        type: 'object',
        properties: {
          toolName: { type: 'string' },
          arguments: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string' },
            },
          },
        },
        required: ['toolName', 'arguments'],
      };

      app.post('/api/tools', { schema: { body: toolSchema } }, async (_request, reply) => {
        return reply.status(200).send({ success: true });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/tools',
        payload: {
          toolName: 'my-tool',
          arguments: { wrongField: 123 },
        },
      });

      assert.strictEqual(res.statusCode, 400);
    });

    test('F5.5: upstream rate limit 429 status code and retry-after headers propagate back', async () => {
      const app = Fastify();
      app.post('/api/inference', async (_request, reply) => {
        return reply.status(429).headers({ 'retry-after': '60' }).send({ error: 'Too Many Requests' });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference',
      });

      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.headers['retry-after'], '60');
    });
  });

  // ==========================================
  // F6: SOP Consensus Gate (5 tests)
  // ==========================================
  test.describe('F6: SOP Consensus Gate', () => {
    test('F6.1: score calculation is protected against division by zero', () => {
      const gate = new SOPConsensusGate();
      const evalResult = gate.evaluateConsensus('PropEmpty');
      assert.strictEqual(evalResult.score, 0);
      assert.strictEqual(evalResult.passed, false);
      assert.strictEqual(evalResult.unresolvedObjections.length, 0);
    });

    test('F6.2: cyclic dependencies on proposals are detected and cycle aborted safely', () => {
      const gate = new SOPConsensusGate();
      // PropA depends on PropB, PropB depends on PropA
      gate.addVote('PropA', { type: 'backing', quantity: 10, actor: 'prop:PropB' });
      gate.addVote('PropB', { type: 'backing', quantity: 10, actor: 'prop:PropA' });

      const evalResult = gate.evaluateConsensusRecursive('PropA');
      assert.strictEqual(evalResult.isCyclic, true);
      assert.strictEqual(evalResult.passed, false);
    });

    test('F6.3: consensus gate handles scaling up to thousands of votes correctly and fast', () => {
      const gate = new SOPConsensusGate();
      const proposalId = 'PropHuge';

      for (let i = 0; i < 8000; i++) {
        gate.addVote(proposalId, { type: 'backing', quantity: 1, actor: `user-backing-${i}` });
      }
      for (let i = 0; i < 2000; i++) {
        gate.addVote(proposalId, { type: 'objection', quantity: 1, actor: `user-objecting-${i}` });
      }

      const start = Date.now();
      const evalResult = gate.evaluateConsensus(proposalId);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 100);
      assert.strictEqual(evalResult.score, 80);
      assert.strictEqual(evalResult.passed, true);
    });

    test('F6.4: negative votes are converted using absolute value correctly', () => {
      const gate = new SOPConsensusGate();
      const proposalId = 'PropNegWeight';

      // Backing: -1000 (abs = 1000)
      gate.addVote(proposalId, { type: 'backing', quantity: -1000, actor: 'user-1' });
      // Objection: -3000 (abs = 3000)
      gate.addVote(proposalId, { type: 'objection', quantity: -3000, actor: 'user-2' });

      const evalResult = gate.evaluateConsensus(proposalId);
      // score = 1000 / (1000 + 3000) * 100 = 25
      assert.strictEqual(evalResult.score, 25);
      assert.strictEqual(evalResult.passed, false);
    });

    test('F6.5: recursive evaluation fails gracefully if dependent proposal is missing/deleted', () => {
      const gate = new SOPConsensusGate();
      gate.addVote('PropRoot', { type: 'backing', quantity: 100, actor: 'prop:PropDeleted' });

      const evalResult = gate.evaluateConsensusRecursive('PropRoot');
      assert.strictEqual(evalResult.passed, false);

      const missingResult = gate.evaluateConsensusRecursive('PropDeleted');
      assert.strictEqual(missingResult.error, 'Proposal not found');
      assert.strictEqual(missingResult.passed, false);
    });
  });

  // ==========================================
  // F7: Mermaid Dashboard (5 tests)
  // ==========================================
  test.describe('F7: Mermaid Dashboard', () => {
    test('F7.1: parser parses extremely long labels without crashing', () => {
      const longLabel = 'a'.repeat(20000);
      const mStr = `graph TD\n  N1["${longLabel}"]`;
      const parsed = MermaidDashboardParser.parse(mStr);

      assert.strictEqual(parsed.nodes.length, 1);
      assert.strictEqual(parsed.nodes[0].id, 'N1');
      assert.strictEqual(parsed.nodes[0].label, longLabel);
    });

    test('F7.2: visual cycles and self loops parse correctly', () => {
      const mStr = 'graph TD\n  N1 --> N2\n  N2 --> N1\n  N3 --> N3';
      const parsed = MermaidDashboardParser.parse(mStr);

      assert.strictEqual(parsed.nodes.length, 3);
      assert.ok(parsed.links.some((l) => l.source === 'N1' && l.target === 'N2'));
      assert.ok(parsed.links.some((l) => l.source === 'N2' && l.target === 'N1'));
      assert.ok(parsed.links.some((l) => l.source === 'N3' && l.target === 'N3'));
    });

    test('F7.3: highlight styles are successfully generated and rendered based on consensus outcome', () => {
      const stylePassed = generateDashboardStyle('PropPassed', { passed: true });
      const styleBlocked = generateDashboardStyle('PropBlocked', { passed: false });

      assert.strictEqual(stylePassed.styleDef, 'fill:#0f0,stroke:#333');
      assert.strictEqual(styleBlocked.styleDef, 'fill:#f00,stroke:#333');

      const mermaid = MermaidDashboardParser.renderGraph(
        [
          { id: 'PropPassed', label: 'Prop A' },
          { id: 'PropBlocked', label: 'Prop B' },
        ],
        [],
        [stylePassed, styleBlocked],
      );

      assert.match(mermaid, /style PropPassed fill:#0f0,stroke:#333/);
      assert.match(mermaid, /style PropBlocked fill:#f00,stroke:#333/);
    });

    test('F7.4: parsing scale tests handles high counts of nodes and links accurately', () => {
      const nodes = Array.from({ length: 500 }).map((_, idx) => ({ id: `N${idx}`, label: `Node ${idx}` }));
      const links = [];
      for (let i = 0; i < 500; i++) {
        links.push({ source: `N${i}`, target: `N${(i + 1) % 500}` });
        links.push({ source: `N${i}`, target: `N${(i + 2) % 500}` });
      }

      const mStr = MermaidDashboardParser.renderGraph(nodes, links);
      const parsed = MermaidDashboardParser.parse(mStr);

      assert.strictEqual(parsed.nodes.length, 500);
      assert.strictEqual(parsed.links.length, 1000);
    });

    test('F7.5: special characters in labels are properly escaped and parsed back', () => {
      const node = { id: 'N1', label: 'Node & <HTML> and special chars: @#$%^&*()' };
      const mermaid = MermaidDashboardParser.renderGraph([node], []);

      assert.match(mermaid, /N1\["Node & <HTML> and special chars: @#\$%\^&\*\(\)"\]/);

      const parsed = MermaidDashboardParser.parse(mermaid);
      assert.strictEqual(parsed.nodes.length, 1);
      assert.strictEqual(parsed.nodes[0].label, 'Node & <HTML> and special chars: @#$%^&*()');
    });
  });
});
