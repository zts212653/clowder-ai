import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Generates an Ed25519 keypair and exports public/private keys in the
 * format expected by Invaluable.
 */
export function generateEd25519Keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // SPKI public key bytes encoded as base64url
  const publicSpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

  // Raw 32-byte private seed bytes encoded as base64url via JWK
  const jwk = privateKey.export({ format: 'jwk' });
  const privateSeed = jwk.d;

  return {
    publicSpki,
    privateSeed,
  };
}

/**
 * Sets up a mock Kotlin/JS P2P data directory containing identity.key.
 */
export function setupDataDirectory(dataDir, name) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const keyPath = path.join(dataDir, 'identity.key');
  let keys;

  if (fs.existsSync(keyPath)) {
    try {
      const content = fs.readFileSync(keyPath, 'utf8');
      const lines = content.split('\n');
      let type, pub, priv;
      for (const line of lines) {
        const [k, v] = line.trim().split('=');
        if (k === 'type') type = v;
        if (k === 'public') pub = v;
        if (k === 'private') priv = v;
      }
      if (type === 'ed25519' && pub && priv) {
        keys = { publicSpki: pub, privateSeed: priv };
      }
    } catch (_err) {
      // If parsing fails, regenerate
    }
  }

  if (!keys) {
    keys = generateEd25519Keys();
    const iniContent = `type=ed25519\npublic=${keys.publicSpki}\nprivate=${keys.privateSeed}\n`;
    fs.writeFileSync(keyPath, iniContent, 'utf8');
  }

  return {
    dataDir,
    name,
    keyPath,
    ...keys,
  };
}

/**
 * Mock Signaling Server to inspect WebRTC signaling events and coordinate peers.
 */
export class MockSignalingServer {
  constructor(port = 51900) {
    this.port = port;
    this.wss = null;
    this.clients = new Map();
    this.events = [];
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' }, () => {
          resolve();
        });

        this.wss.on('connection', (ws) => {
          let clientName = null;

          ws.on('message', (messageStr) => {
            try {
              const msg = JSON.parse(messageStr);
              this.events.push({
                timestamp: Date.now(),
                type: 'message_received',
                payload: msg,
              });

              if (msg.type === 'register') {
                clientName = msg.name;
                this.clients.set(clientName, ws);
                this.events.push({
                  timestamp: Date.now(),
                  type: 'node_registered',
                  name: clientName,
                });
                ws.send(JSON.stringify({ type: 'registered' }));
                return;
              }

              if (msg.to && this.clients.has(msg.to)) {
                const targetWs = this.clients.get(msg.to);
                targetWs.send(
                  JSON.stringify({
                    ...msg,
                    from: clientName,
                  }),
                );
                this.events.push({
                  timestamp: Date.now(),
                  type: 'message_relayed',
                  from: clientName,
                  to: msg.to,
                  messageType: msg.type,
                });
              }
            } catch (err) {
              this.events.push({
                timestamp: Date.now(),
                type: 'error',
                error: err.message,
              });
            }
          });

          ws.on('close', () => {
            if (clientName) {
              this.clients.delete(clientName);
              this.events.push({
                timestamp: Date.now(),
                type: 'node_disconnected',
                name: clientName,
              });
            }
          });
        });

        this.wss.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getEvents() {
    return this.events;
  }

  clearEvents() {
    this.events = [];
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.wss) {
        for (const ws of this.clients.values()) {
          ws.terminate();
        }
        this.clients.clear();
        this.wss.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Simulates a single P2P background peer node.
 */
export class PeerNode {
  constructor(name, dataDir, port = 51900) {
    this.name = name;
    this.dataDir = dataDir;
    this.port = port;
    this.active = false;
    this.ws = null;
    this.inbox = [];
    this.pendingPolls = [];
    this.identity = null;
    this.peers = new Set();
  }

  async start() {
    this.identity = setupDataDirectory(this.dataDir, this.name);
    this.active = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      this.ws.on('open', () => {
        this.ws.send(
          JSON.stringify({
            type: 'register',
            name: this.name,
          }),
        );
      });

      this.ws.on('message', (data) => {
        if (!this.active) return;

        try {
          const msg = JSON.parse(data);

          if (msg.type === 'registered') {
            resolve();
            return;
          }

          if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
            if (msg.from) {
              this.peers.add(msg.from);
            }
            if (msg.type === 'offer') {
              this.ws.send(
                JSON.stringify({
                  type: 'answer',
                  to: msg.from,
                  sdp: 'mock-sdp-answer',
                }),
              );
            }
          }

          if (msg.type === 'inbox_message') {
            this.receiveMessage(msg.payload);
          }
        } catch (_err) {
          // Ignore parsing issues
        }
      });

      this.ws.on('error', (err) => {
        reject(err);
      });
    });
  }

  suspend() {
    this.active = false;
  }

  resume() {
    this.active = true;
  }

  async waitInboxUpdate(timeoutMs = 5000) {
    if (!this.active) {
      throw new Error(`Node ${this.name} is inactive. Cannot wait for inbox update.`);
    }

    if (this.inbox.length > 0) {
      return this.inbox.shift();
    }

    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.pendingPolls = this.pendingPolls.filter((p) => p.resolve !== resolve);
          resolve(null);
        }
      }, timeoutMs);

      this.pendingPolls.push({
        resolve: (msg) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(msg);
          }
        },
      });
    });
  }

  receiveMessage(payload) {
    if (!this.active) return;

    if (this.pendingPolls.length > 0) {
      const poll = this.pendingPolls.shift();
      poll.resolve(payload);
    } else {
      this.inbox.push(payload);
    }
  }

  sendMessage(targetName, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'inbox_message',
          to: targetName,
          payload,
        }),
      );
    }
  }

  async stop() {
    this.active = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Manages the full 5 background nodes mesh.
 */
export class PeerMeshSimulator {
  constructor(baseDataDir = './.loop', port = 51900) {
    this.baseDataDir = baseDataDir;
    this.port = port;
    this.nodes = new Map();
    const names = ['ict-leo', 'ict-mia', 'ict-ravi', 'ict-niko', 'ict-observer'];
    for (const name of names) {
      this.nodes.set(name, new PeerNode(name, path.join(baseDataDir, name), port));
    }
  }

  async start() {
    for (const node of this.nodes.values()) {
      await node.start();
    }
  }

  getNode(name) {
    return this.nodes.get(name);
  }

  async stop() {
    for (const node of this.nodes.values()) {
      await node.stop();
    }
  }
}

/**
 * Enforces and tracks tool write budget limits.
 */
export class WriteLimitedToolInvoker {
  constructor(initialBudget = 3, parentInvoker = null) {
    this.initialBudget = initialBudget;
    this.parentInvoker = parentInvoker;
    this.writeCount = 0;
  }

  get remainingBudget() {
    if (this.parentInvoker) {
      return this.parentInvoker.remainingBudget;
    }
    return Math.max(0, this.initialBudget - this.writeCount);
  }

  consumeWrite() {
    if (this.parentInvoker) {
      this.parentInvoker.consumeWrite();
      return;
    }

    if (this.writeCount >= this.initialBudget) {
      throw new Error(`Write budget exhausted. Limit is ${this.initialBudget} write-actions per turn.`);
    }
    this.writeCount++;
  }

  reset() {
    if (this.parentInvoker) {
      this.parentInvoker.reset();
    } else {
      this.writeCount = 0;
    }
  }

  async invoke(actionName, actionFn, isWrite = false) {
    if (isWrite) {
      this.consumeWrite();
    }
    const metadata = {
      toolName: actionName,
      remainingBudget: this.remainingBudget,
      isWriteAction: isWrite,
    };

    return await actionFn(metadata);
  }
}

/**
 * Mock Model Inference Gateway for Fastify apps.
 */
export class MockInferenceGateway {
  constructor() {
    this.requestHistory = [];
    this.responseQueue = [];
  }

  queueResponse(response) {
    this.responseQueue.push(response);
  }

  clear() {
    this.requestHistory = [];
    this.responseQueue = [];
  }

  register(fastifyApp) {
    fastifyApp.post('/api/inference', async (request, reply) => {
      this.requestHistory.push({
        endpoint: '/api/inference',
        headers: request.headers,
        body: request.body,
        timestamp: Date.now(),
      });

      if (this.responseQueue.length > 0) {
        const nextResponse = this.responseQueue.shift();
        return reply.status(200).send(nextResponse);
      }

      return reply.status(200).send({
        content: [{ type: 'text', text: 'Default simulated response' }],
        role: 'assistant',
      });
    });

    fastifyApp.post('/v1/messages', async (request, reply) => {
      this.requestHistory.push({
        endpoint: '/v1/messages',
        headers: request.headers,
        body: request.body,
        timestamp: Date.now(),
      });

      if (this.responseQueue.length > 0) {
        const nextResponse = this.responseQueue.shift();
        return reply.status(200).send(nextResponse);
      }

      return reply.status(200).send({
        id: `msg_${Math.random().toString(36).substring(7)}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Default compatibility response' }],
        model: request.body.model || 'claude-3-5-sonnet',
      });
    });
  }
}

/**
 * Simulates Link Graph SOP Gate evaluation (Consensus calculations).
 */
export class SOPConsensusGate {
  constructor() {
    this.proposals = new Map();
  }

  registerProposal(proposalId) {
    if (!this.proposals.has(proposalId)) {
      this.proposals.set(proposalId, { votes: [], objections: [] });
    }
  }

  addVote(proposalId, { type, quantity, actor }) {
    this.registerProposal(proposalId);
    const prop = this.proposals.get(proposalId);
    prop.votes.push({ type, quantity, actor });
  }

  addObjection(proposalId, { objectionId, quantity, actor, resolved = false }) {
    this.registerProposal(proposalId);
    const prop = this.proposals.get(proposalId);
    prop.objections.push({ objectionId, quantity, actor, resolved });
  }

  resolveObjection(proposalId, objectionId) {
    const prop = this.proposals.get(proposalId);
    if (prop) {
      const obj = prop.objections.find((o) => o.objectionId === objectionId);
      if (obj) {
        obj.resolved = true;
      }
    }
  }

  evaluateConsensus(proposalId) {
    const prop = this.proposals.get(proposalId);
    if (!prop) {
      return {
        passed: false,
        score: 0,
        unresolvedObjections: [],
        error: 'Proposal not found',
      };
    }

    let positiveWeight = 0;
    let negativeWeight = 0;

    for (const vote of prop.votes) {
      if (vote.type === 'backing') {
        positiveWeight += Math.abs(vote.quantity);
      } else if (vote.type === 'objection') {
        negativeWeight += Math.abs(vote.quantity);
      }
    }

    for (const obj of prop.objections) {
      if (!obj.resolved) {
        negativeWeight += Math.abs(obj.quantity);
      }
    }

    let score = 0;
    const totalWeight = positiveWeight + negativeWeight;
    if (totalWeight > 0) {
      score = (positiveWeight / totalWeight) * 100;
    }

    const unresolvedObjections = prop.objections.filter((o) => !o.resolved);
    const passed = score >= 80 && unresolvedObjections.length === 0;

    return {
      passed,
      score,
      positiveWeight,
      negativeWeight,
      unresolvedObjections,
    };
  }

  evaluateConsensusRecursive(proposalId, visited = new Set()) {
    if (visited.has(proposalId)) {
      return {
        passed: false,
        score: 0,
        unresolvedObjections: [],
        isCyclic: true,
      };
    }
    visited.add(proposalId);

    const localResult = this.evaluateConsensus(proposalId);
    if (localResult.error) {
      return localResult;
    }

    // Recursively check any linked proposals in votes or objections
    // (This simulates complex proposal dependency trees)
    let passed = localResult.passed;
    const score = localResult.score;
    const unresolvedObjections = [...localResult.unresolvedObjections];

    const prop = this.proposals.get(proposalId);
    for (const vote of prop.votes) {
      // If vote is a link/proposal itself
      if (typeof vote.actor === 'string' && vote.actor.startsWith('prop:')) {
        const subId = vote.actor.substring(5);
        const subResult = this.evaluateConsensusRecursive(subId, new Set(visited));
        if (subResult.isCyclic) {
          return subResult;
        }
        if (!subResult.passed) {
          passed = false;
        }
      }
    }

    return {
      passed,
      score,
      unresolvedObjections,
    };
  }
}

/**
 * Validates and parses Mermaid graph representations.
 */
export class MermaidDashboardParser {
  static parse(mermaidString) {
    if (!mermaidString || typeof mermaidString !== 'string') {
      throw new Error('Invalid Mermaid input: must be a non-empty string');
    }

    const lines = mermaidString
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { nodes: [], links: [], styles: [] };
    }

    const firstLine = lines[0];
    const graphDeclPattern = /^(graph|flowchart)\s+(TD|LR|TB|BT|RL)/;
    if (!graphDeclPattern.test(firstLine)) {
      throw new Error('Mermaid graph must start with a valid graph/flowchart declaration (e.g., "graph TD")');
    }

    const nodes = [];
    const links = [];
    const styles = [];

    const nodePattern =
      /^([a-zA-Z0-9_-]+)(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{"([^"]+)"\}|\{([^}]+)\})?$/;
    const linkPattern = /^([a-zA-Z0-9_-]+)\s+(?:-->|---)\s*(?:\|([^|]+)\|)?\s*([a-zA-Z0-9_-]+)$/;
    const stylePattern = /^style\s+([a-zA-Z0-9_-]+)\s+(.+)$/;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      const styleMatch = line.match(stylePattern);
      if (styleMatch) {
        styles.push({
          nodeId: styleMatch[1],
          styleDef: styleMatch[2],
        });
        continue;
      }

      const linkMatch = line.match(linkPattern);
      if (linkMatch) {
        const srcId = linkMatch[1];
        const tgtId = linkMatch[3];
        links.push({
          source: srcId,
          target: tgtId,
          label: linkMatch[2] || null,
        });
        if (!nodes.some((n) => n.id === srcId)) {
          nodes.push({ id: srcId, label: srcId });
        }
        if (!nodes.some((n) => n.id === tgtId)) {
          nodes.push({ id: tgtId, label: tgtId });
        }
        continue;
      }

      const inlineNodePattern =
        /([a-zA-Z0-9_-]+)(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{"([^"]+)"\}|\{([^}]+)\})/g;
      let inlineMatch;
      let foundInline = false;
      while ((inlineMatch = inlineNodePattern.exec(line)) !== null) {
        foundInline = true;
        const id = inlineMatch[1];
        const label =
          inlineMatch[2] ||
          inlineMatch[3] ||
          inlineMatch[4] ||
          inlineMatch[5] ||
          inlineMatch[6] ||
          inlineMatch[7] ||
          id;

        if (!nodes.some((n) => n.id === id)) {
          nodes.push({ id, label });
        }
      }

      if (!foundInline) {
        const nodeMatch = line.match(nodePattern);
        if (nodeMatch) {
          const id = nodeMatch[1];
          const label =
            nodeMatch[2] || nodeMatch[3] || nodeMatch[4] || nodeMatch[5] || nodeMatch[6] || nodeMatch[7] || id;
          if (!nodes.some((n) => n.id === id)) {
            nodes.push({ id, label });
          }
        }
      }
    }

    return {
      nodes,
      links,
      styles,
    };
  }

  static renderGraph(nodes, links, styles = []) {
    let mermaid = 'graph TD\n';
    for (const node of nodes) {
      const safeLabel = node.label.replace(/"/g, '\\"');
      mermaid += `  ${node.id}["${safeLabel}"]\n`;
    }
    for (const link of links) {
      if (link.label) {
        mermaid += `  ${link.source} -->|${link.label}| ${link.target}\n`;
      } else {
        mermaid += `  ${link.source} --> ${link.target}\n`;
      }
    }
    for (const style of styles) {
      mermaid += `  style ${style.nodeId} ${style.styleDef}\n`;
    }
    return mermaid;
  }
}
