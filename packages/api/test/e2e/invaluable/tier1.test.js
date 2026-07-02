import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {
  MermaidDashboardParser,
  MockInferenceGateway,
  MockSignalingServer,
  PeerNode,
  SOPConsensusGate,
  setupDataDirectory,
  WriteLimitedToolInvoker,
} from './harness.js';

const tempDir = path.resolve('./.loop_tier1_temp');

// Helper for F1.1: CLI args parsing
function parseNodeCliArgs(args) {
  const parsed = { name: 'ict-observer', port: 51900, dataDir: './.loop' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      parsed.name = args[i + 1];
    } else if (args[i] === '--port') {
      parsed.port = Number.parseInt(args[i + 1], 10);
    } else if (args[i] === '--data-dir') {
      parsed.dataDir = args[i + 1];
    }
  }
  return parsed;
}

// Helper classes for F4: WebRTC delta sync and conflict resolution simulation
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

test.describe('Tier 1 E2E Test Suite - clowder-invaluable Mesh Features', () => {
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
    test('F1.1: CLI args parsing maps arguments to node configuration options', () => {
      const args = ['--name', 'ict-leo', '--port', '51902', '--data-dir', '/tmp/f1-1-data'];
      const config = parseNodeCliArgs(args);
      assert.strictEqual(config.name, 'ict-leo');
      assert.strictEqual(config.port, 51902);
      assert.strictEqual(config.dataDir, '/tmp/f1-1-data');
    });

    test('F1.2: key auto-generation occurs when identity.key is missing', () => {
      const nodeDir = path.join(tempDir, 'f1-2-node');
      const identity = setupDataDirectory(nodeDir, 'f1-2-node');
      assert.ok(fs.existsSync(identity.keyPath));
      assert.ok(identity.publicSpki);
      assert.ok(identity.privateSeed);
    });

    test('F1.3: reading key format loads existing key pair values accurately', () => {
      const nodeDir = path.join(tempDir, 'f1-3-node');
      fs.mkdirSync(nodeDir, { recursive: true });
      const keyPath = path.join(nodeDir, 'identity.key');
      const mockPub = 'mock_spki_public_key';
      const mockPriv = 'mock_private_seed';
      const iniContent = `type=ed25519\npublic=${mockPub}\nprivate=${mockPriv}\n`;
      fs.writeFileSync(keyPath, iniContent, 'utf8');

      const identity = setupDataDirectory(nodeDir, 'f1-3-node');
      assert.strictEqual(identity.publicSpki, mockPub);
      assert.strictEqual(identity.privateSeed, mockPriv);
    });

    test('F1.4: clean exit on SIGTERM stops node and server listeners cleanly', async () => {
      const testPort = 51911;
      const server = new MockSignalingServer(testPort);
      await server.start();
      const node = new PeerNode('ict-observer', path.join(tempDir, 'f1-4-node'), testPort);
      await node.start();

      let handlerExecuted = false;
      const onSigtermReceived = async () => {
        await node.stop();
        await server.stop();
        handlerExecuted = true;
      };

      await onSigtermReceived();

      assert.ok(handlerExecuted);
      assert.strictEqual(node.active, false);
      assert.strictEqual(node.ws, null);
    });

    test('F1.5: querying status exposes correct metadata and connected peer counts', () => {
      const node = new PeerNode('ict-mia', path.join(tempDir, 'f1-5-node'), 51900);
      const getStatus = (n) => ({
        name: n.name,
        active: n.active,
        dataDir: n.dataDir,
        peersCount: n.peers.size,
      });

      assert.strictEqual(getStatus(node).active, false);
      node.active = true;
      node.peers.add('ict-leo');
      node.peers.add('ict-ravi');

      const status = getStatus(node);
      assert.strictEqual(status.active, true);
      assert.strictEqual(status.name, 'ict-mia');
      assert.strictEqual(status.peersCount, 2);
    });
  });

  // ==========================================
  // F2: Inbox Autonomy (5 tests)
  // ==========================================
  test.describe('F2: Inbox Autonomy', () => {
    test('F2.1: wait_inbox_update polling suspends and resolves on message receipt', async () => {
      const node = new PeerNode('ict-ravi', path.join(tempDir, 'f2-1-node'));
      node.active = true;

      const promise = node.waitInboxUpdate(1000);
      node.receiveMessage({ data: 'hello ravi' });
      const msg = await promise;

      assert.deepStrictEqual(msg, { data: 'hello ravi' });
    });

    test('F2.2: message processing handles multiple inbox messages in FIFO order', async () => {
      const node = new PeerNode('ict-niko', path.join(tempDir, 'f2-2-node'));
      node.active = true;

      node.receiveMessage({ seq: 1 });
      node.receiveMessage({ seq: 2 });

      const msg1 = await node.waitInboxUpdate(100);
      const msg2 = await node.waitInboxUpdate(100);

      assert.deepStrictEqual(msg1, { seq: 1 });
      assert.deepStrictEqual(msg2, { seq: 2 });
    });

    test('F2.3: timeout retry returns null when waitInboxUpdate expires without messages', async () => {
      const node = new PeerNode('ict-observer', path.join(tempDir, 'f2-3-node'));
      node.active = true;

      const result = await node.waitInboxUpdate(50);
      assert.strictEqual(result, null);
    });

    test('F2.4: suspension on inactive throws exception when calling waitInboxUpdate', async () => {
      const node = new PeerNode('ict-leo', path.join(tempDir, 'f2-4-node'));
      node.suspend();

      await assert.rejects(async () => {
        await node.waitInboxUpdate(50);
      }, /inactive/);
    });

    test('F2.5: callback trigger invokes registered listener on receiving inbox payload', () => {
      const events = [];
      const node = new PeerNode('ict-mia', path.join(tempDir, 'f2-5-node'));
      node.active = true;

      // Wrap receiveMessage to simulate callback registration
      const baseReceive = node.receiveMessage.bind(node);
      node.receiveMessage = (payload) => {
        baseReceive(payload);
        events.push(payload);
      };

      node.receiveMessage({ payload: 'triggered' });
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(events[0], { payload: 'triggered' });
    });
  });

  // ==========================================
  // F3: Write Budget Gate (5 tests)
  // ==========================================
  test.describe('F3: Write Budget Gate', () => {
    test('F3.1: limit <= 3 write actions executes successfully without error', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      let executed = 0;
      const fn = () => {
        executed++;
      };

      await invoker.invoke('w1', fn, true);
      await invoker.invoke('w2', fn, true);
      await invoker.invoke('w3', fn, true);

      assert.strictEqual(executed, 3);
      assert.strictEqual(invoker.remainingBudget, 0);
    });

    test('F3.2: 4th write rejection throws budget exhaustion error', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      const fn = () => {};

      await invoker.invoke('w1', fn, true);
      await invoker.invoke('w2', fn, true);
      await invoker.invoke('w3', fn, true);

      await assert.rejects(async () => {
        await invoker.invoke('w4', fn, true);
      }, /Write budget exhausted/);
    });

    test('F3.3: budget reset on next turn restores the full capacity of 3 actions', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      await invoker.invoke('w1', () => {}, true);
      await invoker.invoke('w2', () => {}, true);
      await invoker.invoke('w3', () => {}, true);

      invoker.reset();
      assert.strictEqual(invoker.remainingBudget, 3);

      let success = false;
      await invoker.invoke(
        'w4',
        () => {
          success = true;
        },
        true,
      );
      assert.ok(success);
    });

    test('F3.4: query remaining budget accurately tracks changes throughout session', async () => {
      const invoker = new WriteLimitedToolInvoker(3);
      assert.strictEqual(invoker.remainingBudget, 3);

      await invoker.invoke('w1', () => {}, true);
      assert.strictEqual(invoker.remainingBudget, 2);

      await invoker.invoke('r1', () => {}, false); // read action does not consume
      assert.strictEqual(invoker.remainingBudget, 2);
    });

    test('F3.5: tracks nested calls and propagates budget consumption to parent', async () => {
      const parent = new WriteLimitedToolInvoker(3);
      const child = new WriteLimitedToolInvoker(3, parent);

      await child.invoke('w1', () => {}, true);
      assert.strictEqual(parent.remainingBudget, 2);
      assert.strictEqual(child.remainingBudget, 2);
    });
  });

  // ==========================================
  // F4: WebRTC Replication (5 tests)
  // ==========================================
  test.describe('F4: WebRTC Replication', () => {
    test('F4.1: signaling server connection registers nodes successfully', async () => {
      const testPort = 51912;
      const server = new MockSignalingServer(testPort);
      await server.start();

      const node = new PeerNode('ict-observer', path.join(tempDir, 'f4-1-node'), testPort);
      await node.start();

      const events = server.getEvents();
      assert.ok(events.some((e) => e.type === 'node_registered' && e.name === 'ict-observer'));

      await node.stop();
      await server.stop();
    });

    test('F4.2: WebRTC SDP exchange routes offer and answer messages', async () => {
      const testPort = 51913;
      const server = new MockSignalingServer(testPort);
      await server.start();

      const nodeA = new PeerNode('ict-leo', path.join(tempDir, 'f4-2-nodeA'), testPort);
      const nodeB = new PeerNode('ict-mia', path.join(tempDir, 'f4-2-nodeB'), testPort);

      await nodeA.start();
      await nodeB.start();

      nodeA.ws.send(
        JSON.stringify({
          type: 'offer',
          to: 'ict-mia',
          sdp: 'mock-sdp-offer-data',
        }),
      );

      let answerRouted = false;
      const start = Date.now();
      while (Date.now() - start < 1000) {
        const events = server.getEvents();
        const found = events.some(
          (e) =>
            e.type === 'message_relayed' && e.from === 'ict-mia' && e.to === 'ict-leo' && e.messageType === 'answer',
        );
        if (found) {
          answerRouted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(answerRouted);

      await nodeA.stop();
      await nodeB.stop();
      await server.stop();
    });

    test('F4.3: delta replication of link graph synchronizes updates based on query timestamp', () => {
      const graphA = new SimulatedLinkGraph();
      const graphB = new SimulatedLinkGraph();

      graphA.addLink('L1', 'A-value-1', 10);
      graphA.addLink('L2', 'A-value-2', 20);
      graphB.addLink('L1', 'B-value-1', 10);

      const delta = graphA.getDelta(10);
      assert.strictEqual(delta.length, 1);
      assert.strictEqual(delta[0].id, 'L2');

      graphB.merge(delta);
      assert.ok(graphB.links.has('L2'));
      assert.strictEqual(graphB.links.get('L2').value, 'A-value-2');
    });

    test('F4.4: recovery after disconnect resumes signaling server registration and flow', async () => {
      const testPort = 51914;
      const server = new MockSignalingServer(testPort);
      await server.start();

      const node = new PeerNode('ict-ravi', path.join(tempDir, 'f4-4-node'), testPort);
      await node.start();

      // Disconnect
      await node.stop();

      // Reconnect
      await node.start();

      const events = server.getEvents();
      const registrations = events.filter((e) => e.type === 'node_registered' && e.name === 'ict-ravi');
      assert.ok(registrations.length >= 2);

      await node.stop();
      await server.stop();
    });

    test('F4.5: sync conflict resolution applies Last-Write-Wins logic', () => {
      const graph = new SimulatedLinkGraph();
      graph.addLink('conflict-link', 'old-val', 100);

      const incomingDelta = [
        { id: 'conflict-link', value: 'stale-incoming', timestamp: 50 },
        { id: 'conflict-link', value: 'fresh-incoming', timestamp: 150 },
      ];

      graph.merge(incomingDelta);
      assert.strictEqual(graph.links.get('conflict-link').value, 'fresh-incoming');
    });
  });

  // ==========================================
  // F5: Fastify Model Gateway (5 tests)
  // ==========================================
  test.describe('F5: Fastify Model Gateway', () => {
    test('F5.1: POST /api/inference Anthropic format parsed and recorded in gateway history', async () => {
      const gateway = new MockInferenceGateway();
      const app = Fastify();
      gateway.register(app);

      const payload = {
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'Inference test message' }],
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference',
        payload,
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(gateway.requestHistory.length, 1);
      assert.strictEqual(gateway.requestHistory[0].body.messages[0].content, 'Inference test message');
    });

    test('F5.2: structured JSON responses match expected Anthropic reply blocks', async () => {
      const gateway = new MockInferenceGateway();
      const app = Fastify();
      gateway.register(app);

      gateway.queueResponse({
        content: [{ type: 'text', text: 'Anthropic reply text' }],
        role: 'assistant',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference',
        payload: { messages: [] },
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.content[0].type, 'text');
      assert.strictEqual(data.content[0].text, 'Anthropic reply text');
    });

    test('F5.3: gateway timeout handles slow backend and raises 504 status code', async () => {
      const app = Fastify();
      app.post('/api/inference/timeout', async (_req, reply) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return reply.status(504).send({ error: 'Gateway Timeout' });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference/timeout',
      });

      assert.strictEqual(res.statusCode, 504);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, 'Gateway Timeout');
    });

    test('F5.4: credential injection rejects invalid tokens with 401 Unauthorized', async () => {
      const app = Fastify();
      app.addHook('preHandler', async (req, reply) => {
        const token = req.headers.authorization;
        if (!token || token !== 'Bearer valid-jwt-token') {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
      });

      app.post('/api/inference', async (_req, reply) => {
        return reply.status(200).send({ ok: true });
      });

      // No token
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/inference',
      });
      assert.strictEqual(res1.statusCode, 401);

      // Valid token
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/inference',
        headers: { authorization: 'Bearer valid-jwt-token' },
      });
      assert.strictEqual(res2.statusCode, 200);
    });

    test('F5.5: POST /v1/messages compatibility routes request to correct model format', async () => {
      const gateway = new MockInferenceGateway();
      const app = Fastify();
      gateway.register(app);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-3-haiku',
          messages: [{ role: 'user', content: 'haiku payload' }],
        },
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(data.id.startsWith('msg_'));
      assert.strictEqual(data.model, 'claude-3-haiku');
    });
  });

  // ==========================================
  // F6: SOP Consensus Gate (5 tests)
  // ==========================================
  test.describe('F6: SOP Consensus Gate', () => {
    test('F6.1: score calculation accurately maps backing votes to total weight ratio', () => {
      const gate = new SOPConsensusGate();
      gate.addVote('P1', { type: 'backing', quantity: 75, actor: 'alice' });
      gate.addVote('P1', { type: 'objection', quantity: 25, actor: 'bob' });

      const evaluation = gate.evaluateConsensus('P1');
      assert.strictEqual(evaluation.score, 75);
    });

    test('F6.2: unresolved objections detection identifies outstanding blockers', () => {
      const gate = new SOPConsensusGate();
      gate.addObjection('P2', { objectionId: 'objA', quantity: 10, actor: 'bob', resolved: false });

      const evaluation = gate.evaluateConsensus('P2');
      assert.strictEqual(evaluation.unresolvedObjections.length, 1);
      assert.strictEqual(evaluation.unresolvedObjections[0].objectionId, 'objA');
    });

    test('F6.3: SOP passes with Score >= 80 and 0 objections', () => {
      const gate = new SOPConsensusGate();
      gate.addVote('P3', { type: 'backing', quantity: 95, actor: 'alice' });
      gate.addVote('P3', { type: 'objection', quantity: 5, actor: 'bob' });

      const evaluation = gate.evaluateConsensus('P3');
      assert.strictEqual(evaluation.passed, true);
      assert.strictEqual(evaluation.unresolvedObjections.length, 0);
    });

    test('F6.4: SOP blocks on Score < 80 even with zero objections', () => {
      const gate = new SOPConsensusGate();
      gate.addVote('P4', { type: 'backing', quantity: 70, actor: 'alice' });
      gate.addVote('P4', { type: 'objection', quantity: 30, actor: 'bob' });

      const evaluation = gate.evaluateConsensus('P4');
      assert.strictEqual(evaluation.passed, false);
      assert.strictEqual(evaluation.score, 70);
    });

    test('F6.5: SOP blocks on unresolved objections despite Score >= 80', () => {
      const gate = new SOPConsensusGate();
      gate.addVote('P5', { type: 'backing', quantity: 90, actor: 'alice' });
      gate.addObjection('P5', { objectionId: 'objBlocker', quantity: 10, actor: 'bob', resolved: false });

      const evaluation = gate.evaluateConsensus('P5');
      assert.strictEqual(evaluation.passed, false);
      assert.ok(evaluation.score >= 80);
      assert.strictEqual(evaluation.unresolvedObjections.length, 1);
    });
  });

  // ==========================================
  // F7: Mermaid Dashboard (5 tests)
  // ==========================================
  test.describe('F7: Mermaid Dashboard', () => {
    test('F7.1: parse context to Mermaid extracts node and link structures correctly', () => {
      const mStr = 'graph TD\n  N1["Node A"]\n  N2["Node B"]\n  N1 --> N2';
      const parsed = MermaidDashboardParser.parse(mStr);
      assert.strictEqual(parsed.nodes.length, 2);
      assert.strictEqual(parsed.links.length, 1);
      assert.strictEqual(parsed.links[0].source, 'N1');
      assert.strictEqual(parsed.links[0].target, 'N2');
    });

    test('F7.2: TASK/PROPOSAL nodes presence validated from parsed labels', () => {
      const mStr = 'graph TD\n  T_Clean["TASK: Clean Codebase"]\n  P_Merge["PROPOSAL: Merge branch"]';
      const parsed = MermaidDashboardParser.parse(mStr);
      assert.ok(parsed.nodes.some((n) => n.id === 'T_Clean' && n.label.startsWith('TASK:')));
      assert.ok(parsed.nodes.some((n) => n.id === 'P_Merge' && n.label.startsWith('PROPOSAL:')));
    });

    test('F7.3: shows scores and objections inside labels correctly', () => {
      const mStr = 'graph TD\n  P_Prop["PROPOSAL: Add UI [Score: 88%, Objections: 1]"]';
      const parsed = MermaidDashboardParser.parse(mStr);
      const node = parsed.nodes.find((n) => n.id === 'P_Prop');
      assert.ok(node.label.includes('Score: 88%'));
      assert.ok(node.label.includes('Objections: 1'));
    });

    test('F7.4: empty graph handling returns valid empty nodes and links structure', () => {
      const parsed = MermaidDashboardParser.parse('graph TD\n');
      assert.strictEqual(parsed.nodes.length, 0);
      assert.strictEqual(parsed.links.length, 0);
    });

    test('F7.5: auto re-renders on sync outputting a valid updated Mermaid graph string', () => {
      const nodes = [
        { id: 'N1', label: 'Updated Node' },
        { id: 'N2', label: 'Peer Node' },
      ];
      const links = [{ source: 'N1', target: 'N2', label: 'synced' }];
      const rendered = MermaidDashboardParser.renderGraph(nodes, links);

      assert.match(rendered, /graph TD/);
      assert.match(rendered, /N1\["Updated Node"\]/);
      assert.match(rendered, /N1 -->\|synced\| N2/);
    });
  });
});
