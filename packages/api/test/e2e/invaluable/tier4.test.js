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

const tempDir = path.resolve('./.loop_tier4_temp');

test.describe('Tier 4 E2E Test Suite - clowder-invaluable Mesh Features', () => {
  test.before(() => {
    if (fs.existsSync(tempDir) === false) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  test.after(() => {
    if (fs.existsSync(tempDir) === true) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 1: 5-agent P2P Brainstorm (F1, F2, F3, F4, F5)
  // Full brainstorm flow among 5 nodes with messaging, WebRTC sync, model gateway, and write-limit checks.
  test('Scenario 1: 5-agent P2P Brainstorm (F1, F2, F3, F4, F5)', async () => {
    const testPort = 51971;
    const server = new MockSignalingServer(testPort);
    await server.start();

    const gateway = new MockInferenceGateway();
    const app = Fastify();
    gateway.register(app);
    await app.listen({ port: 0 });

    const nodes = [
      new PeerNode('ict-leo', path.join(tempDir, 's1-leo'), testPort),
      new PeerNode('ict-mia', path.join(tempDir, 's1-mia'), testPort),
      new PeerNode('ict-ravi', path.join(tempDir, 's1-ravi'), testPort),
      new PeerNode('ict-niko', path.join(tempDir, 's1-niko'), testPort),
      new PeerNode('ict-observer', path.join(tempDir, 's1-observer'), testPort),
    ];

    // F1: Node startup
    await Promise.all(nodes.map((n) => n.start()));

    // Verify identity key setup
    for (const node of nodes) {
      assert.ok(fs.existsSync(path.join(node.dataDir, 'identity.key')));
    }

    // F3: Write Budget initialization for each node
    const invokers = nodes.map(() => new WriteLimitedToolInvoker(3));

    // Queue response in Model Gateway (F5) for Node 2, 3, 4, 5
    gateway.queueResponse({
      content: [{ type: 'text', text: 'IDEA: Lamport timestamps' }],
      role: 'assistant',
    });
    gateway.queueResponse({
      content: [{ type: 'text', text: 'IDEA: Vector clocks' }],
      role: 'assistant',
    });
    gateway.queueResponse({
      content: [{ type: 'text', text: 'IDEA: CRDTs' }],
      role: 'assistant',
    });
    gateway.queueResponse({
      content: [{ type: 'text', text: 'IDEA: Converged Graph' }],
      role: 'assistant',
    });

    // F4: Simulate messaging & WebRTC sync brainstorm flow
    // Node 1 (ict-leo) initiates brainstorm
    nodes[0].sendMessage('ict-mia', { topic: 'scaling', idea: 'P2P Gossip' });

    // Node 2 (ict-mia) receives
    const msgFromLeo = await nodes[1].waitInboxUpdate(2000);
    assert.ok(msgFromLeo);
    assert.strictEqual(msgFromLeo.idea, 'P2P Gossip');

    // Node 2 Autonomy turn (F2) & Gateway Query (F5) & Write Limit check (F3)
    const resMia = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: msgFromLeo.idea }] },
    });
    assert.strictEqual(resMia.statusCode, 200);
    const bodyMia = JSON.parse(resMia.body);
    const ideaMia = bodyMia.content[0].text;
    assert.strictEqual(ideaMia, 'IDEA: Lamport timestamps');

    await invokers[1].invoke('write_idea', () => {}, true);
    assert.strictEqual(invokers[1].remainingBudget, 2);

    nodes[1].sendMessage('ict-ravi', { topic: 'scaling', idea: ideaMia });

    // Node 3 (ict-ravi) receives
    const msgFromMia = await nodes[2].waitInboxUpdate(2000);
    assert.ok(msgFromMia);
    assert.strictEqual(msgFromMia.idea, 'IDEA: Lamport timestamps');

    const resRavi = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: msgFromMia.idea }] },
    });
    const ideaRavi = JSON.parse(resRavi.body).content[0].text;
    assert.strictEqual(ideaRavi, 'IDEA: Vector clocks');

    await invokers[2].invoke('write_idea', () => {}, true);
    assert.strictEqual(invokers[2].remainingBudget, 2);

    nodes[2].sendMessage('ict-niko', { topic: 'scaling', idea: ideaRavi });

    // Node 4 (ict-niko) receives
    const msgFromRavi = await nodes[3].waitInboxUpdate(2000);
    assert.ok(msgFromRavi);
    assert.strictEqual(msgFromRavi.idea, 'IDEA: Vector clocks');

    const resNiko = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: msgFromRavi.idea }] },
    });
    const ideaNiko = JSON.parse(resNiko.body).content[0].text;
    assert.strictEqual(ideaNiko, 'IDEA: CRDTs');

    await invokers[3].invoke('write_idea', () => {}, true);
    assert.strictEqual(invokers[3].remainingBudget, 2);

    nodes[3].sendMessage('ict-observer', { topic: 'scaling', idea: ideaNiko });

    // Node 5 (ict-observer) receives
    const msgFromNiko = await nodes[4].waitInboxUpdate(2000);
    assert.ok(msgFromNiko);
    assert.strictEqual(msgFromNiko.idea, 'IDEA: CRDTs');

    const resObserver = await app.inject({
      method: 'POST',
      url: '/api/inference',
      payload: { messages: [{ role: 'user', content: msgFromNiko.idea }] },
    });
    const ideaObserver = JSON.parse(resObserver.body).content[0].text;
    assert.strictEqual(ideaObserver, 'IDEA: Converged Graph');

    await invokers[4].invoke('write_idea', () => {}, true);
    assert.strictEqual(invokers[4].remainingBudget, 2);

    // F3: Write-limit checks on Node 5
    await invokers[4].invoke('write_idea_2', () => {}, true);
    await invokers[4].invoke('write_idea_3', () => {}, true);
    assert.strictEqual(invokers[4].remainingBudget, 0);

    // Try a 4th write action on Node 5, must fail
    await assert.rejects(async () => {
      await invokers[4].invoke('write_idea_4', () => {}, true);
    }, /Write budget exhausted/);

    // Clean up
    await Promise.all(nodes.map((n) => n.stop()));
    await server.stop();
    await app.close();
  });

  // Scenario 2: Proposal Consensus & SOP Pass (F2, F4, F6, F7)
  // Proposal creation, positive consensus accumulation, SOP pass verification, and Mermaid dashboard rendering checks.
  test('Scenario 2: Proposal Consensus & SOP Pass (F2, F4, F6, F7)', () => {
    const gate = new SOPConsensusGate();
    const proposalId = 'Prop_Consensus_Pass';

    // F6: Create proposal & accumulate positive consensus
    gate.registerProposal(proposalId);
    gate.addVote(proposalId, { type: 'backing', quantity: 70, actor: 'ict-mia' });
    gate.addVote(proposalId, { type: 'backing', quantity: 20, actor: 'ict-ravi' });

    // SOP pass verification
    const result = gate.evaluateConsensus(proposalId);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.unresolvedObjections.length, 0);

    // F7: Mermaid dashboard rendering checks
    const nodes = [
      { id: 'Prop_Consensus_Pass', label: 'PROPOSAL: SOP Pass' },
      { id: 'ict_mia', label: 'Mia Node' },
      { id: 'ict_ravi', label: 'Ravi Node' },
    ];
    const links = [
      { source: 'ict_mia', target: 'Prop_Consensus_Pass', label: 'backs 70' },
      { source: 'ict_ravi', target: 'Prop_Consensus_Pass', label: 'backs 20' },
    ];
    const styles = [{ nodeId: 'Prop_Consensus_Pass', styleDef: 'fill:#d4edda,stroke:#28a745' }];

    const mermaidStr = MermaidDashboardParser.renderGraph(nodes, links, styles);
    assert.match(mermaidStr, /Prop_Consensus_Pass/);
    assert.match(mermaidStr, /backs 70/);
    assert.match(mermaidStr, /backs 20/);

    const parsed = MermaidDashboardParser.parse(mermaidStr);
    assert.strictEqual(parsed.nodes.length, 3);
    assert.strictEqual(parsed.links.length, 2);
    assert.strictEqual(parsed.styles.length, 1);

    const propNode = parsed.nodes.find((n) => n.id === 'Prop_Consensus_Pass');
    assert.ok(propNode);
    assert.strictEqual(propNode.label, 'PROPOSAL: SOP Pass');
  });

  // Scenario 3: Proposal Objection & SOP Block (F2, F4, F6, F7)
  // Proposal creation, objection fact creation (negative backing quantity), SOP gate block verification, and Mermaid dashboard rendering checks.
  test('Scenario 3: Proposal Objection & SOP Block (F2, F4, F6, F7)', () => {
    const gate = new SOPConsensusGate();
    const proposalId = 'Prop_Objection_Block';

    // F6: Create proposal and add objection fact (negative backing quantity) & standard objection
    gate.registerProposal(proposalId);
    // Negative backing quantity
    gate.addVote(proposalId, { type: 'backing', quantity: -30, actor: 'ict-mia' });
    // Objection vote
    gate.addVote(proposalId, { type: 'objection', quantity: 50, actor: 'ict-niko' });
    // Objection fact
    gate.addObjection(proposalId, { objectionId: 'obj1', quantity: 40, actor: 'ict-ravi', resolved: false });

    // SOP gate block verification
    const result = gate.evaluateConsensus(proposalId);
    assert.strictEqual(result.passed, false);
    // positive weight: |-30| = 30.
    // negative weight: |50| + |40| = 90.
    // score: 30 / (30 + 90) = 25%
    assert.strictEqual(result.score, 25);
    assert.strictEqual(result.unresolvedObjections.length, 1);

    // F7: Mermaid dashboard rendering checks
    const nodes = [
      { id: 'Prop_Objection_Block', label: 'PROPOSAL: SOP Blocked' },
      { id: 'obj1', label: 'Objection: Missing failover tests' },
    ];
    const links = [{ source: 'obj1', target: 'Prop_Objection_Block', label: 'blocks' }];
    const styles = [{ nodeId: 'Prop_Objection_Block', styleDef: 'fill:#f8d7da,stroke:#dc3545' }];

    const mermaidStr = MermaidDashboardParser.renderGraph(nodes, links, styles);
    assert.match(mermaidStr, /Prop_Objection_Block/);
    assert.match(mermaidStr, /blocks/);

    const parsed = MermaidDashboardParser.parse(mermaidStr);
    assert.strictEqual(parsed.nodes.length, 2);
    assert.strictEqual(parsed.links.length, 1);
    assert.strictEqual(parsed.styles.length, 1);

    const objNode = parsed.nodes.find((n) => n.id === 'obj1');
    assert.ok(objNode);
    assert.strictEqual(objNode.label, 'Objection: Missing failover tests');
  });

  // Scenario 4: Budget Exhaustion Recovery (F2, F3)
  // Enforcing write limits within a turn, rejecting actions on exhaustion, stepping the autonomy loop to a new turn, and verifying budget recovery.
  test('Scenario 4: Budget Exhaustion Recovery (F2, F3)', async () => {
    const invoker = new WriteLimitedToolInvoker(3);

    // Enforcing write limits
    await invoker.invoke('write1', () => {}, true);
    await invoker.invoke('write2', () => {}, true);
    await invoker.invoke('write3', () => {}, true);
    assert.strictEqual(invoker.remainingBudget, 0);

    // Rejecting actions on exhaustion
    await assert.rejects(async () => {
      await invoker.invoke('write4', () => {}, true);
    }, /Write budget exhausted/);

    // F2: Step autonomy loop to a new turn (resets the tool budget)
    invoker.reset();

    // Verifying budget recovery
    assert.strictEqual(invoker.remainingBudget, 3);
    await invoker.invoke('write5', () => {}, true);
    assert.strictEqual(invoker.remainingBudget, 2);
  });

  // Scenario 5: Next.js Dashboard Mindmap Render (F1, F4, F7)
  // Constructing a complex discussion graph (tasks, proposals, backing links, objection links) and parsing it into a correct visual Mermaid.js representation.
  test('Scenario 5: Next.js Dashboard Mindmap Render (F1, F4, F7)', () => {
    const nodes = [
      { id: 'T_1', label: 'TASK: WebRTC sync scaling' },
      { id: 'T_2', label: 'TASK: Secure local wallet' },
      { id: 'P_1', label: 'PROPOSAL: Delta gossip protocol' },
      { id: 'P_2', label: 'PROPOSAL: Encrypted LevelDB' },
      { id: 'O_1', label: 'OBJECTION: Increased bandwidth' },
    ];

    const links = [
      { source: 'P_1', target: 'T_1', label: 'backs' },
      { source: 'P_2', target: 'T_2', label: 'backs' },
      { source: 'O_1', target: 'P_1', label: 'objection' },
    ];

    const styles = [
      { nodeId: 'T_1', styleDef: 'fill:#f9f,stroke:#333' },
      { nodeId: 'T_2', styleDef: 'fill:#f9f,stroke:#333' },
      { nodeId: 'O_1', styleDef: 'fill:#ff9,stroke:#f00' },
    ];

    // F7: Render to Mermaid.js representation
    const mermaidStr = MermaidDashboardParser.renderGraph(nodes, links, styles);

    // Parse it back to verify correctness
    const parsed = MermaidDashboardParser.parse(mermaidStr);
    assert.strictEqual(parsed.nodes.length, 5);
    assert.strictEqual(parsed.links.length, 3);
    assert.strictEqual(parsed.styles.length, 3);

    const taskNode = parsed.nodes.find((n) => n.id === 'T_1');
    assert.ok(taskNode);
    assert.strictEqual(taskNode.label, 'TASK: WebRTC sync scaling');

    const backingLink = parsed.links.find((l) => l.source === 'P_1' && l.target === 'T_1');
    assert.ok(backingLink);
    assert.strictEqual(backingLink.label, 'backs');

    const objectionLink = parsed.links.find((l) => l.source === 'O_1' && l.target === 'P_1');
    assert.ok(objectionLink);
    assert.strictEqual(objectionLink.label, 'objection');

    const style1 = parsed.styles.find((s) => s.nodeId === 'T_1');
    assert.ok(style1);
    assert.strictEqual(style1.styleDef, 'fill:#f9f,stroke:#333');
  });
});
