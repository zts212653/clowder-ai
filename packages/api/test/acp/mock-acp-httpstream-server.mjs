#!/usr/bin/env node

/**
 * Mock ACP HTTP streaming server for local testing of AcpHttpStreamClient.
 *
 * Usage:
 *   node mock-acp-httpstream-server.mjs [--port 0]
 *
 * Prints the listening port to stdout for port discovery by AcpHttpStreamClient.
 * Responds to ACP JSON-RPC methods:
 *   - initialize   → returns agent info + capabilities
 *   - session/new  → returns a session ID
 *   - session/prompt → streams NDJSON notifications + final response
 *   - session/cancel → acknowledged
 *
 * Configure via cat-config.json with transport: 'httpstream'.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    hostname: { type: 'string', default: '127.0.0.1' },
  },
});

const PORT = Number(values.port) || 0;
const HOSTNAME = values.hostname ?? '127.0.0.1';

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function notification(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

const sessions = new Map();

function handleInitialize(id) {
  return jsonRpcResponse(id, {
    agentInfo: { name: 'mock-acp-httpstream', version: '1.0.0' },
    agentCapabilities: {
      loadSession: false,
      mcpCapabilities: { http: true, sse: true },
    },
  });
}

function handleSessionNew(id, params) {
  const sessionId = `mock-session-${randomUUID().slice(0, 8)}`;
  sessions.set(sessionId, { cwd: params?.cwd, created: Date.now() });
  return jsonRpcResponse(id, { sessionId });
}

async function handleSessionPrompt(id, params, res) {
  const sessionId = params?.sessionId;
  const promptText = params?.prompt?.[0]?.text ?? '(no prompt)';

  // Stream NDJSON: notifications first, then final response
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
  });

  // Simulate thinking
  const write = (data) => res.write(data + '\n');

  write(
    notification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        chunk: `Processing: "${promptText.slice(0, 50)}"`,
      },
    }),
  );

  await sleep(200);

  // Simulate a text response
  const responseText = `[Mock ACP httpstream] Echo: ${promptText}`;

  write(
    notification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'assistant_text',
        text: responseText,
      },
    }),
  );

  await sleep(100);

  // Final response
  write(
    jsonRpcResponse(id, {
      stopReason: 'end_turn',
      text: responseText,
    }),
  );

  res.end();
}

function handleSessionCancel(id, params) {
  return jsonRpcResponse(id, { cancelled: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const { method, id, params } = msg;

  switch (method) {
    case 'initialize':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(handleInitialize(id));
      break;

    case 'session/new':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(handleSessionNew(id, params));
      break;

    case 'session/prompt':
      await handleSessionPrompt(id, params, res);
      break;

    case 'session/cancel':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(handleSessionCancel(id, params));
      break;

    default:
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  }
});

server.listen(PORT, HOSTNAME, () => {
  const addr = server.address();
  // This line is what AcpHttpStreamClient.discoverPort() matches
  console.log(`Listening on port ${addr.port}`);
  console.error(`[mock-acp-httpstream] ready at http://${HOSTNAME}:${addr.port}`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
