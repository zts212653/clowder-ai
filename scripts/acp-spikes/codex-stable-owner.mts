import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

type Packet = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};
export async function stableOwner(options: {
  bundle: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  syntheticPrompt: string;
  allowedSteer: string;
  mcpServers: unknown[];
}) {
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env, ...options.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith('CODEX_') &&
      ![
        'CODEX_HOME',
        'CODEX_PATH',
        'CODEX_CONFIG',
        'CODEX_SANDBOX_NETWORK_DISABLED',
        'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
      ].includes(key)
    )
      delete env[key];
  const child = spawn(process.execPath, [options.bundle], { cwd: options.cwd, env, stdio: 'pipe', windowsHide: true });
  child.stderr.resume();
  const pending = new Map<
    string | number,
    { response: ServerResponse; params?: Record<string, unknown>; method?: string }
  >();
  let allowedSessionId: unknown;
  let admittedPrompts = 0;
  const frames: Array<{ t: number; direction: string; packet?: Packet; method?: string; id?: string | number }> = [];
  let initializeParams: string | undefined,
    initializeReply: Packet | undefined,
    initializeId: string | number | undefined;
  const send = (packet: Packet) => child.stdin.write(JSON.stringify(packet) + '\n');
  const permission = (packet: Packet) => {
    const call = packet.params?.toolCall as Record<string, unknown> | undefined;
    const raw = call?.rawInput as Record<string, unknown> | undefined;
    const input = (raw?.arguments ?? raw) as Record<string, unknown> | undefined;
    const selected = (packet.params?.options as Array<{ optionId: string; kind: string }> | undefined)?.find(
      (e) => e.kind === 'allow_once',
    );
    const allowed =
      String(call?.title ?? '').includes('read_fixture') && input?.scenario === 'A' && input.delayMs === 8000;
    send({
      jsonrpc: '2.0',
      id: packet.id,
      result: {
        outcome: allowed && selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' },
      },
    });
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let packet: Packet;
    try {
      packet = JSON.parse(line);
    } catch {
      return;
    }
    frames.push({ t: Date.now(), direction: 'bridge-out', packet });
    if (packet.method && packet.id !== undefined) {
      if (packet.method === 'session/request_permission') permission(packet);
      else send({ jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'No additional test host tools' } });
      return;
    }
    if (packet.id !== undefined) {
      if (packet.id === initializeId && !packet.error) initializeReply = packet;
      const wait = pending.get(packet.id);
      if (!wait) return;
      if (wait.method === 'session/new' && !packet.error) allowedSessionId = packet.result?.sessionId;
      if (!wait.response.destroyed) wait.response.end(JSON.stringify(packet) + '\n');
      else frames.push({ t: Date.now(), direction: 'response-lost', id: packet.id });
      pending.delete(packet.id);
      return;
    }
    const sessionId = packet.params?.sessionId;
    for (const wait of pending.values())
      if (wait.params?.sessionId === sessionId && !wait.response.destroyed)
        wait.response.write(JSON.stringify(packet) + '\n');
  });
  const server = createServer(async (req, res) => {
    const header = String(req.headers.authorization ?? '');
    const expected = `Bearer ${token}`;
    if (header.length !== expected.length || !timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
      res.writeHead(403).end();
      return;
    }
    let text = '';
    for await (const part of req) {
      text += part.toString();
      if (text.length > 65536) {
        res.writeHead(413).end();
        return;
      }
    }
    let packet: Packet;
    try {
      packet = JSON.parse(text);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (packet.id === undefined || pending.has(packet.id)) {
      res.writeHead(400).end();
      return;
    }
    if (
      !['initialize', 'session/new', 'session/set_mode', 'session/prompt', '_clowder/v1/control'].includes(
        packet.method ?? '',
      )
    ) {
      res.writeHead(403).end();
      return;
    }
    const allowedKeys =
      packet.method === 'initialize'
        ? ['protocolVersion', 'clientInfo', 'clientCapabilities']
        : packet.method === 'session/new'
          ? ['cwd', 'mcpServers']
          : packet.method === 'session/set_mode'
            ? ['sessionId', 'modeId']
            : packet.method === 'session/prompt'
              ? ['sessionId', 'prompt']
              : [
                  'action',
                  'sessionId',
                  'operationId',
                  'nativeSessionId',
                  'expectedTurnId',
                  'bindingRevision',
                  'prompt',
                ];
    if (Object.keys(packet.params ?? {}).some((key) => !allowedKeys.includes(key))) {
      res.writeHead(403).end();
      return;
    }
    if (!['initialize', 'session/new'].includes(packet.method ?? '') && packet.params?.sessionId !== allowedSessionId) {
      res.writeHead(403).end();
      return;
    }
    if (
      packet.method === 'session/prompt' &&
      JSON.stringify(packet.params?.prompt) !== JSON.stringify([{ type: 'text', text: options.syntheticPrompt }])
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      packet.method === '_clowder/v1/control' &&
      !['snapshot', 'steer', 'receipt'].includes(String(packet.params?.action))
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      packet.method === '_clowder/v1/control' &&
      packet.params?.action === 'steer' &&
      JSON.stringify(packet.params?.prompt) !== JSON.stringify([{ type: 'text', text: options.allowedSteer }])
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      packet.method === 'session/new' &&
      (allowedSessionId !== undefined ||
        packet.params?.cwd !== options.cwd ||
        JSON.stringify(packet.params?.mcpServers) !== JSON.stringify(options.mcpServers) ||
        Object.keys(packet.params ?? {}).some((key) => !['cwd', 'mcpServers'].includes(key)))
    ) {
      res.writeHead(403).end();
      return;
    }
    if (packet.method === 'session/set_mode' && packet.params?.modeId !== 'read-only') {
      res.writeHead(403).end();
      return;
    }
    frames.push({ t: Date.now(), direction: 'http-in', packet });
    res.setHeader('Content-Type', 'application/x-ndjson');
    if (packet.method === 'initialize') {
      const frozen = JSON.stringify(packet.params);
      if (initializeParams && frozen !== initializeParams) {
        res.writeHead(409).end();
        return;
      }
      if (initializeReply) {
        res.end(JSON.stringify({ ...initializeReply, id: packet.id }) + '\n');
        frames.push({ t: Date.now(), direction: 'initialize-frozen-replay', id: packet.id });
        return;
      }
      if (initializeId !== undefined) {
        res.writeHead(409).end();
        return;
      }
      initializeParams = frozen;
      initializeId = packet.id;
    }
    pending.set(packet.id, { response: res, params: packet.params, method: packet.method });
    if (packet.method === 'session/prompt' && ++admittedPrompts > 1) {
      pending.delete(packet.id);
      res.writeHead(403).end();
      return;
    }
    res.on('close', () =>
      frames.push({ t: Date.now(), direction: 'http-consumer-closed', id: packet.id, method: packet.method }),
    );
    send(packet);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  let n = 0;
  const request = async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      signal,
    });
    if (!response.ok) throw new Error(`test_owner_http_${response.status}`);
    const text = await response.text();
    const packets = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Packet);
    const result = packets.at(-1)!;
    if (result.error) throw new Error(String(result.error.message));
    return result.result!;
  };
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      for (const wait of pending.values()) wait.response.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      child.stdin.end();
      await new Promise<void>((r) => {
        const timer = setTimeout(() => {
          child.kill();
          r();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          r();
        });
      });
    })());
  return {
    pid: child.pid,
    frames,
    request,
    close,
  };
}
