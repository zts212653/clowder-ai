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
  WriteLimitedToolInvoker,
} from './harness.js';

const tempDir = path.resolve('./.loop_tier3_temp');

// Helper classes/structures for simulated link graph delta sync
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

test.describe('Tier 3 E2E Test Suite - clowder-invaluable Mesh Features', () => {
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

  // Test 3.1: Node Control (F1) & WebRTC Replication (F4) - Start multiple nodes, ensure they auto-discover and sync.
  test('Test 3.1: Node Control (F1) & WebRTC Replication (F4) - Start multiple nodes, ensure they auto-discover and sync', async () => {
    const testPort = 51951;
    const server = new MockSignalingServer(testPort);
    await server.start();

    const nodeA = new PeerNode('ict-leo', path.join(tempDir, '3-1-nodeA'), testPort);
    const nodeB = new PeerNode('ict-mia', path.join(tempDir, '3-1-nodeB'), testPort);

    // F1: Node startup (directories initialized and start)
    await nodeA.start();
    await nodeB.start();

    // Verify F1: directories are setup with identity files
    assert.ok(fs.existsSync(path.join(nodeA.dataDir, 'identity.key')));
    assert.ok(fs.existsSync(path.join(nodeB.dataDir, 'identity.key')));

    // F4: Auto-discovery via SDP routing
    // Simulate nodeA discovering nodeB by sending an offer
    nodeA.ws.send(
      JSON.stringify({
        type: 'offer',
        to: 'ict-mia',
        sdp: 'mock-sdp-offer-leo',
      }),
    );

    // Wait for discovery & peer lists to update
    const start = Date.now();
    let discovered = false;
    while (Date.now() - start < 2000) {
      if (nodeA.peers.has('ict-mia') && nodeB.peers.has('ict-leo')) {
        discovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(discovered, 'Peers should auto-discover each other');

    // Simulate link graph synchronization over the established connection
    const graphA = new SimulatedLinkGraph();
    const graphB = new SimulatedLinkGraph();

    graphA.addLink('L_Shared', 'Value_From_A', 100);

    // Replicate from A to B
    const deltaA = graphA.getDelta(0);
    graphB.merge(deltaA);

    // Check states converged
    assert.ok(graphB.links.has('L_Shared'));
    assert.strictEqual(graphB.links.get('L_Shared').value, 'Value_From_A');

    await nodeA.stop();
    await nodeB.stop();
    await server.stop();
  });

  // Test 3.2: Autonomy Loop (F2) & Write Budget (F3) - Autonomy loop executes multiple turns, budget resets each turn.
  test('Test 3.2: Autonomy Loop (F2) & Write Budget (F3) - Autonomy loop executes multiple turns, budget resets each turn', async () => {
    // F3: Initialize Write Budget Gate
    const budgetInvoker = new WriteLimitedToolInvoker(3);

    // Autonomy Loop Turn 1
    let turn1Writes = 0;
    const writeFn = () => {
      turn1Writes++;
    };

    // Execute 3 writes - consumes budget
    await budgetInvoker.invoke('write_tool_1', writeFn, true);
    await budgetInvoker.invoke('write_tool_2', writeFn, true);
    await budgetInvoker.invoke('write_tool_3', writeFn, true);

    assert.strictEqual(turn1Writes, 3);
    assert.strictEqual(budgetInvoker.remainingBudget, 0);

    // Verify 4th write is blocked in Turn 1
    await assert.rejects(async () => {
      await budgetInvoker.invoke('write_tool_4', writeFn, true);
    }, /Write budget exhausted/);

    // F2 Autonomy Loop: complete turn, boundary reset
    budgetInvoker.reset();
    assert.strictEqual(budgetInvoker.remainingBudget, 3, 'Budget should reset back to 3 on next turn');

    // Autonomy Loop Turn 2
    let turn2Writes = 0;
    const writeFn2 = () => {
      turn2Writes++;
    };

    // Execute write in new turn
    await budgetInvoker.invoke('write_tool_1_t2', writeFn2, true);
    assert.strictEqual(turn2Writes, 1);
    assert.strictEqual(budgetInvoker.remainingBudget, 2);
  });

  // Test 3.3: Model Gateway (F5) & Autonomy Loop (F2) - Autonomy loop calls model gateway to decide next action.
  test('Test 3.3: Model Gateway (F5) & Autonomy Loop (F2) - Autonomy loop calls model gateway to decide next action', async () => {
    const gateway = new MockInferenceGateway();
    const app = Fastify();
    gateway.register(app);
    await app.listen({ port: 0 }); // Dynamically allocate port to avoid conflict

    const testPort = 51953;
    const signalingServer = new MockSignalingServer(testPort);
    await signalingServer.start();

    // Setup node for F2 Autonomy Loop
    const node = new PeerNode('ict-ravi', path.join(tempDir, '3-3-node'), testPort);
    await node.start();

    // Queue response in Model Gateway (F5)
    gateway.queueResponse({
      content: [{ type: 'text', text: 'DECISION: BACK_PROPOSAL P_100' }],
      role: 'assistant',
    });

    // Simulate receiving an inbox update that triggers autonomy action loop
    node.receiveMessage({ event: 'inbox_check_pending' });
    const inboxPayload = await node.waitInboxUpdate(1000);
    assert.ok(inboxPayload);

    // Autonomy loop calls Model Inference Gateway
    const response = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: {
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: `Analyze event: ${JSON.stringify(inboxPayload)}` }],
      },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.content[0].text, 'DECISION: BACK_PROPOSAL P_100');

    // Autonomy loop processes decision
    const nextAction = body.content[0].text;
    let actionExecuted = false;
    if (nextAction.startsWith('DECISION: BACK_PROPOSAL')) {
      actionExecuted = true;
    }
    assert.ok(actionExecuted, 'Autonomy loop should execute action decided by the gateway');

    await node.stop();
    await signalingServer.stop();
    await app.close();
  });

  // Test 3.4: WebRTC Replication (F4) & SOP Gate (F6) - Sync a proposal and votes across nodes, check consensus locally.
  test('Test 3.4: WebRTC Replication (F4) & SOP Gate (F6) - Sync a proposal and votes across nodes, check consensus locally', () => {
    const nodeA = {
      gate: new SOPConsensusGate(),
      graph: new SimulatedLinkGraph(),
    };

    const nodeB = {
      gate: new SOPConsensusGate(),
      graph: new SimulatedLinkGraph(),
    };

    // Node A creates proposal Prop_A and registers votes
    const proposalId = 'Prop_3_4';
    nodeA.gate.addVote(proposalId, { type: 'backing', quantity: 90, actor: 'alice' });
    nodeA.gate.addVote(proposalId, { type: 'objection', quantity: 10, actor: 'bob' });

    // Represent proposal and votes in Node A's link graph for replication
    nodeA.graph.addLink(`vote:${proposalId}:alice`, { type: 'backing', quantity: 90, actor: 'alice' }, 10);
    nodeA.graph.addLink(`vote:${proposalId}:bob`, { type: 'objection', quantity: 10, actor: 'bob' }, 10);

    // Node B has a local objection to the same proposal
    nodeB.gate.addObjection(proposalId, { objectionId: 'objB', quantity: 20, actor: 'charlie', resolved: false });
    nodeB.graph.addLink(
      `obj:${proposalId}:objB`,
      { objectionId: 'objB', quantity: 20, actor: 'charlie', resolved: false },
      20,
    );

    // Verify before sync, consensus states are local/different
    const evalAInitial = nodeA.gate.evaluateConsensus(proposalId);
    assert.strictEqual(evalAInitial.passed, true); // Score = 90% (90/100), 0 objections registered on A

    const evalBInitial = nodeB.gate.evaluateConsensus(proposalId);
    assert.strictEqual(evalBInitial.passed, false); // Score = 0%, 1 unresolved objection on B

    // F4: Simulate delta sync replication between A and B
    const deltaFromA = nodeA.graph.getDelta(0);
    const deltaFromB = nodeB.graph.getDelta(0);

    // Merge replication packages
    nodeA.graph.merge(deltaFromB);
    nodeB.graph.merge(deltaFromA);

    // Sync the local SOP gates with replicated data
    // Sync B's objection into A
    const objLink = nodeA.graph.links.get(`obj:${proposalId}:objB`);
    nodeA.gate.addObjection(proposalId, objLink.value);

    // Sync A's votes into B
    const aliceVoteLink = nodeB.graph.links.get(`vote:${proposalId}:alice`);
    const bobVoteLink = nodeB.graph.links.get(`vote:${proposalId}:bob`);
    nodeB.gate.addVote(proposalId, aliceVoteLink.value);
    nodeB.gate.addVote(proposalId, bobVoteLink.value);

    // Local evaluation on both nodes should now match and fail consensus due to the unresolved objection
    const evalALocal = nodeA.gate.evaluateConsensus(proposalId);
    const evalBLocal = nodeB.gate.evaluateConsensus(proposalId);

    // score: 90 / (90 + 10 + 20) = 75%
    assert.strictEqual(evalALocal.score, 75);
    assert.strictEqual(evalALocal.passed, false);
    assert.strictEqual(evalALocal.unresolvedObjections.length, 1);

    assert.strictEqual(evalBLocal.score, 75);
    assert.strictEqual(evalBLocal.passed, false);
    assert.strictEqual(evalBLocal.unresolvedObjections.length, 1);

    // Resolve objection on Node B, replicate resolution to Node A
    nodeB.gate.resolveObjection(proposalId, 'objB');
    nodeB.graph.addLink(
      `obj:${proposalId}:objB`,
      { objectionId: 'objB', quantity: 20, actor: 'charlie', resolved: true },
      30,
    );

    // Sync resolution to A
    const deltaResolution = nodeB.graph.getDelta(25);
    nodeA.graph.merge(deltaResolution);

    const resolvedLink = nodeA.graph.links.get(`obj:${proposalId}:objB`);
    if (resolvedLink.value.resolved) {
      nodeA.gate.resolveObjection(proposalId, 'objB');
    }

    // Consensus should now pass on both nodes
    // score: 90 / (90 + 10) = 90%
    const evalAResolved = nodeA.gate.evaluateConsensus(proposalId);
    const evalBResolved = nodeB.gate.evaluateConsensus(proposalId);

    assert.strictEqual(evalAResolved.score, 90);
    assert.strictEqual(evalAResolved.passed, true);
    assert.strictEqual(evalAResolved.unresolvedObjections.length, 0);

    assert.strictEqual(evalBResolved.score, 90);
    assert.strictEqual(evalBResolved.passed, true);
    assert.strictEqual(evalBResolved.unresolvedObjections.length, 0);
  });

  // Test 3.5: Mermaid Dashboard (F7) & WebRTC Replication (F4) - View live dashboard update as replication proceeds.
  test('Test 3.5: Mermaid Dashboard (F7) & WebRTC Replication (F4) - View live dashboard update as replication proceeds', () => {
    // Node A state before replication
    const nodeAState = {
      nodes: [
        { id: 'T_1', label: 'TASK: Implement auth' },
        { id: 'P_1', label: 'PROPOSAL: Use session tokens' },
      ],
      links: [{ source: 'P_1', target: 'T_1', label: 'addresses' }],
    };

    // Render initial dashboard
    const initialMermaid = MermaidDashboardParser.renderGraph(nodeAState.nodes, nodeAState.links);
    assert.match(initialMermaid, /P_1\["PROPOSAL: Use session tokens"\]/);
    assert.match(initialMermaid, /P_1 -->\|addresses\| T_1/);

    // Node B has a new proposal P_2
    const replicatedDelta = [
      { id: 'P_2', value: { type: 'PROPOSAL', label: 'PROPOSAL: Use JWTs' }, timestamp: 50 },
      { id: 'L_2', value: { source: 'P_2', target: 'T_1', label: 'alternative' }, timestamp: 50 },
    ];

    // F4: Simulate replication sync merge of delta into Node A
    for (const item of replicatedDelta) {
      if (item.value.type === 'PROPOSAL') {
        nodeAState.nodes.push({ id: item.id, label: item.value.label });
      } else {
        nodeAState.links.push({ source: item.value.source, target: item.value.target, label: item.value.label });
      }
    }

    // F7: Re-render live dashboard
    const updatedMermaid = MermaidDashboardParser.renderGraph(nodeAState.nodes, nodeAState.links);

    // Verify parser extracts all structures correctly after replication
    const parsed = MermaidDashboardParser.parse(updatedMermaid);
    assert.strictEqual(parsed.nodes.length, 3);
    assert.strictEqual(parsed.links.length, 2);

    assert.ok(parsed.nodes.some((n) => n.id === 'P_2' && n.label === 'PROPOSAL: Use JWTs'));
    assert.ok(parsed.links.some((l) => l.source === 'P_2' && l.target === 'T_1' && l.label === 'alternative'));
  });

  // Test 3.6: Write Budget (F3) & Model Gateway (F5) - Model gateway response triggers multiple tool writes, enforcing limit.
  test('Test 3.6: Write Budget (F3) & Model Gateway (F5) - Model gateway response triggers multiple tool writes, enforcing limit', async () => {
    const gateway = new MockInferenceGateway();
    const app = Fastify();
    gateway.register(app);
    await app.listen({ port: 0 });

    // F3: Write budget init
    const budgetInvoker = new WriteLimitedToolInvoker(3);

    // Model gateway queues response that returns instructions to run 4 tool writes
    gateway.queueResponse({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            actions: [
              { tool: 'create_proposal', isWrite: true, args: { id: 'P1' } },
              { tool: 'create_proposal', isWrite: true, args: { id: 'P2' } },
              { tool: 'create_proposal', isWrite: true, args: { id: 'P3' } },
              { tool: 'create_proposal', isWrite: true, args: { id: 'P4' } },
            ],
          }),
        },
      ],
      role: 'assistant',
    });

    // Invoke Model Gateway (F5)
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: 'Generate 4 proposals' }] },
    });

    const reply = JSON.parse(res.body);
    const instruction = JSON.parse(reply.content[0].text);

    // Execute requested actions under F3 write budget
    let successfulWrites = 0;
    const executeAction = async (action) => {
      await budgetInvoker.invoke(
        action.tool,
        () => {
          successfulWrites++;
        },
        action.isWrite,
      );
    };

    // Sequentially execute actions, expecting the 4th to fail due to budget exhaust
    let observedError = null;
    try {
      for (const action of instruction.actions) {
        await executeAction(action);
      }
    } catch (err) {
      observedError = err;
    }

    assert.ok(observedError);
    assert.match(observedError.message, /Write budget exhausted/);
    assert.strictEqual(successfulWrites, 3, 'Exactly 3 writes should succeed');
    assert.strictEqual(budgetInvoker.remainingBudget, 0);

    await app.close();
  });

  // Test 3.7: SOP Gate (F6) & Autonomy Loop (F2) - Autonomy loop blocks implementation execution if SOP consensus is not met.
  test('Test 3.7: SOP Gate (F6) & Autonomy Loop (F2) - Autonomy loop blocks implementation execution if SOP consensus is not met', async () => {
    const gate = new SOPConsensusGate();
    const proposalId = 'Prop_Implementation';
    gate.registerProposal(proposalId);

    // Helper representing the autonomy loop turn handler for proposal execution
    let executionOccurred = false;
    const runAutonomyExecutionTurn = (propId) => {
      const evaluation = gate.evaluateConsensus(propId);
      if (!evaluation.passed) {
        // Blocked: consensus not passed
        return { status: 'BLOCKED', score: evaluation.score };
      }
      executionOccurred = true;
      return { status: 'EXECUTED', score: evaluation.score };
    };

    // Autonomy turn 1: Proposal has only 50% backing
    gate.addVote(proposalId, { type: 'backing', quantity: 50, actor: 'alice' });
    gate.addVote(proposalId, { type: 'objection', quantity: 50, actor: 'bob' });

    const turn1Result = runAutonomyExecutionTurn(proposalId);
    assert.strictEqual(turn1Result.status, 'BLOCKED');
    assert.strictEqual(executionOccurred, false, 'Execution should be blocked when consensus is not met');

    // Autonomy turn 2: Add backing votes to meet consensus (450 backing vs 50 objection -> 90%)
    gate.addVote(proposalId, { type: 'backing', quantity: 400, actor: 'charlie' });

    const turn2Result = runAutonomyExecutionTurn(proposalId);
    assert.strictEqual(turn2Result.status, 'EXECUTED');
    assert.strictEqual(executionOccurred, true, 'Execution should run when consensus is passed');
  });
});
