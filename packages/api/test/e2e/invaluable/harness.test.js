import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { InvaluableNodeManager } from '../../../dist/domains/cats/services/agents/providers/InvaluableNodeManager.js';
import {
  generateEd25519Keys,
  MermaidDashboardParser,
  MockInferenceGateway,
  MockSignalingServer,
  PeerNode,
  SOPConsensusGate,
  setupDataDirectory,
  WriteLimitedToolInvoker,
} from './harness.js';

const tempDir = path.resolve('./.loop_test_temp');

test.describe('E2E Test Harness Verification Suite', () => {
  test.after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('generateEd25519Keys generates valid base64url keys', () => {
    const keys = generateEd25519Keys();
    assert.ok(keys.publicSpki);
    assert.ok(keys.privateSeed);
    assert.strictEqual(typeof keys.publicSpki, 'string');
    assert.strictEqual(typeof keys.privateSeed, 'string');
  });

  test('setupDataDirectory creates identity.key successfully', () => {
    const nodeDir = path.join(tempDir, 'test-node');
    const result = setupDataDirectory(nodeDir, 'test-node');
    assert.strictEqual(result.name, 'test-node');
    assert.ok(fs.existsSync(result.keyPath));

    const content = fs.readFileSync(result.keyPath, 'utf8');
    assert.match(content, /type=ed25519/);
    assert.match(content, /public=/);
    assert.match(content, /private=/);
  });

  test('MockSignalingServer and PeerNode message exchange', async () => {
    const testPort = 51909;
    const server = new MockSignalingServer(testPort);
    await server.start();

    const node1Dir = path.join(tempDir, 'ict-leo');
    const node2Dir = path.join(tempDir, 'ict-mia');

    const node1 = new PeerNode('ict-leo', node1Dir, testPort);
    const node2 = new PeerNode('ict-mia', node2Dir, testPort);

    await node1.start();
    await node2.start();

    node1.sendMessage('ict-mia', { content: 'hello from leo' });

    const message = await node2.waitInboxUpdate(2000);
    assert.deepStrictEqual(message, { content: 'hello from leo' });

    const events = server.getEvents();
    assert.ok(events.length > 0);
    const registered = events.some((e) => e.type === 'node_registered' && e.name === 'ict-leo');
    assert.ok(registered);

    await node1.stop();
    await node2.stop();
    await server.stop();
  });

  test('waitInboxUpdate respects timeout and inactivity', async () => {
    const node = new PeerNode('ict-ravi', path.join(tempDir, 'ict-ravi'));
    node.active = true;

    const result = await node.waitInboxUpdate(100);
    assert.strictEqual(result, null);

    node.suspend();
    await assert.rejects(async () => {
      await node.waitInboxUpdate(100);
    }, /inactive/);
  });

  test('WriteLimitedToolInvoker enforces budget limits and nested calls', async () => {
    const rootInvoker = new WriteLimitedToolInvoker(3);

    const result = await rootInvoker.invoke(
      'query_state',
      (meta) => {
        assert.strictEqual(meta.remainingBudget, 3);
        return 'success';
      },
      false,
    );
    assert.strictEqual(result, 'success');
    assert.strictEqual(rootInvoker.remainingBudget, 3);

    await rootInvoker.invoke(
      'write_state',
      (meta) => {
        assert.strictEqual(meta.remainingBudget, 2);
      },
      true,
    );

    await rootInvoker.invoke(
      'write_state',
      (meta) => {
        assert.strictEqual(meta.remainingBudget, 1);
      },
      true,
    );

    await rootInvoker.invoke(
      'write_state',
      (meta) => {
        assert.strictEqual(meta.remainingBudget, 0);
      },
      true,
    );

    await assert.rejects(async () => {
      await rootInvoker.invoke('write_state', () => {}, true);
    }, /Write budget exhausted/);

    rootInvoker.reset();
    assert.strictEqual(rootInvoker.remainingBudget, 3);

    const childInvoker = new WriteLimitedToolInvoker(3, rootInvoker);
    await childInvoker.invoke(
      'nested_write',
      (meta) => {
        assert.strictEqual(meta.remainingBudget, 2);
      },
      true,
    );
    assert.strictEqual(rootInvoker.remainingBudget, 2);
  });

  test('MockInferenceGateway handles inference requests and queue responses', async () => {
    const gateway = new MockInferenceGateway();
    const app = Fastify();
    gateway.register(app);

    gateway.queueResponse({
      content: [{ type: 'text', text: 'injected text response' }],
      role: 'assistant',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: 'test' }] },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.content[0].text, 'injected text response');
    assert.strictEqual(gateway.requestHistory.length, 1);
    assert.strictEqual(gateway.requestHistory[0].body.messages[0].content, 'test');
  });

  test('SOPConsensusGate calculates scores and maps objections correctly', () => {
    const gate = new SOPConsensusGate();

    gate.addVote('p1', { type: 'backing', quantity: 80, actor: 'alice' });
    gate.addVote('p1', { type: 'objection', quantity: 20, actor: 'bob' });

    let evalRes = gate.evaluateConsensus('p1');
    assert.strictEqual(evalRes.score, 80);
    assert.strictEqual(evalRes.passed, true);

    gate.addObjection('p1', { objectionId: 'obj1', quantity: 10, actor: 'charlie' });
    evalRes = gate.evaluateConsensus('p1');
    assert.strictEqual(evalRes.score, (80 / (80 + 20 + 10)) * 100);
    assert.strictEqual(evalRes.passed, false);
    assert.strictEqual(evalRes.unresolvedObjections.length, 1);

    gate.resolveObjection('p1', 'obj1');
    evalRes = gate.evaluateConsensus('p1');
    assert.strictEqual(evalRes.score, 80);
    assert.strictEqual(evalRes.passed, true);
    assert.strictEqual(evalRes.unresolvedObjections.length, 0);
  });

  test('MermaidDashboardParser parses and renders Mermaid graph correctly', () => {
    const m = `graph TD
      A[TASK]
      B["Proposal label"]
      C --> D
      style A fill:#f9f,stroke:#333
    `;

    const parsed = MermaidDashboardParser.parse(m);
    assert.strictEqual(parsed.nodes.length, 4);
    assert.ok(parsed.nodes.some((n) => n.id === 'A' && n.label === 'TASK'));
    assert.ok(parsed.nodes.some((n) => n.id === 'B' && n.label === 'Proposal label'));
    assert.strictEqual(parsed.links.length, 1);
    assert.strictEqual(parsed.links[0].source, 'C');
    assert.strictEqual(parsed.links[0].target, 'D');
    assert.strictEqual(parsed.styles.length, 1);

    const rendered = MermaidDashboardParser.renderGraph(parsed.nodes, parsed.links, parsed.styles);
    assert.match(rendered, /graph TD/);
    assert.match(rendered, /A\["TASK"\]/);
  });

  test('InvaluableNodeManager provisions, starts, and stops nodes', async () => {
    const manager = InvaluableNodeManager.getInstance();
    const nodeName = 'ict-observer';
    const dataDir = manager.getDataDir(nodeName);
    assert.ok(dataDir, 'Data directory path should be resolved');

    // Clean up dataDir if it already exists to test fresh provisioning
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    // Provision node
    manager.provisionNode(nodeName);

    // Verify key files are created
    assert.ok(fs.existsSync(dataDir), 'Data directory should exist');
    const keyPath = path.join(dataDir, 'identity.key');
    assert.ok(fs.existsSync(keyPath), 'identity.key should exist');

    const content = fs.readFileSync(keyPath, 'utf8');
    assert.match(content, /type=ed25519/, 'identity.key should have type=ed25519');
    assert.match(content, /public=/, 'identity.key should have public key');
    assert.match(content, /private=/, 'identity.key should have private key');

    const lines = content.split('\n');
    const pubLine = lines.find((l) => l.startsWith('public='));
    const privLine = lines.find((l) => l.startsWith('private='));
    assert.ok(pubLine, 'public key line exists');
    assert.ok(privLine, 'private key line exists');
    const pubVal = pubLine.split('=')[1];
    const privVal = privLine.split('=')[1];
    assert.strictEqual(pubVal.length, 59, 'public key should be 59 chars (44 bytes base64url)');
    assert.strictEqual(privVal.length, 86, 'private key should be 86 chars (64 bytes base64url)');

    // Start node
    manager.startNode(nodeName);
    const proc = manager.getNodeProcess(nodeName);
    assert.ok(proc, 'Child process should be spawned');
    assert.strictEqual(proc.killed, false, 'Child process should be running');

    // Wait slightly to ensure process doesn't fail
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(proc.killed, false, 'Child process should still be running after 500ms');

    // Stop all nodes
    manager.stopAll();
    const procAfterStop = manager.getNodeProcess(nodeName);
    assert.ok(!procAfterStop, 'Node process should be cleared from tracker');
    assert.strictEqual(proc.killed, true, 'Child process should be killed');
  });
});
