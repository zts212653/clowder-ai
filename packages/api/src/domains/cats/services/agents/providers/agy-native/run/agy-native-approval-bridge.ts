import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { RuntimeInteractionPort } from '../../../../../../runtime-interaction/ports/RuntimeInteractionPort.js';
import type { AuditContext } from '../../../../types.js';

export interface AgyNativeApprovalBridge {
  readonly bridgeFile: string;
  dispose(): Promise<void>;
}

interface BridgeRequestPayload {
  readonly token?: unknown;
  readonly conversationId?: unknown;
  readonly stepIdx?: unknown;
  readonly callId?: unknown;
  readonly toolName?: unknown;
  readonly args?: unknown;
  readonly cwd?: unknown;
  readonly approvedTask?: unknown;
}

function safeTokenMatch(expectedHex: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(candidate, 'utf8'));
  } catch {
    return false;
  }
}

export async function startAgyNativeApprovalBridge(input: {
  readonly runHome: string;
  readonly runtimeInteractionPort: RuntimeInteractionPort;
  readonly auditContext: AuditContext;
  readonly signal?: AbortSignal;
}): Promise<AgyNativeApprovalBridge> {
  const lifetime = new AbortController();
  const bridgeSignal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
  const token = randomBytes(32).toString('hex');
  const bridgeFile = join(input.runHome, '.gemini/config/.cat-cafe-approval-bridge.json');

  const server: Server = createServer(async (req, res) => {
    const requestLifetime = new AbortController();
    const signal = AbortSignal.any([bridgeSignal, requestLifetime.signal]);
    res.once('close', () => requestLifetime.abort());
    const reply = (statusCode: number, body: Record<string, unknown>) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(statusCode, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/approve') {
      reply(404, { approved: false, reason: 'unknown approval route' });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.byteLength;
        if (bytes > 512 * 1024) {
          reply(413, { approved: false, reason: 'approval payload too large' });
          return;
        }
        chunks.push(buf);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as BridgeRequestPayload;
      if (!safeTokenMatch(token, parsed.token)) {
        reply(403, { approved: false, reason: 'invalid approval token' });
        return;
      }
      if (signal.aborted) {
        reply(200, { approved: false, reason: 'invocation cancelled before approval' });
        return;
      }
      const toolName = typeof parsed.toolName === 'string' && parsed.toolName.trim() ? parsed.toolName.trim() : 'tool';
      const requestId =
        typeof parsed.callId === 'string' && parsed.callId.trim()
          ? parsed.callId.trim()
          : typeof parsed.stepIdx === 'number' && Number.isInteger(parsed.stepIdx)
            ? parsed.stepIdx
            : randomUUID();
      const description = JSON.stringify(
        { cwd: parsed.cwd ?? null, approvedTask: parsed.approvedTask, args: parsed.args ?? {} },
        null,
        2,
      );

      const response = await input.runtimeInteractionPort.request(
        {
          version: 1,
          interactionId: `agy-pretool-${randomUUID()}`,
          kind: 'approval',
          owner: {
            userId: input.auditContext.userId,
            threadId: input.auditContext.threadId,
            catId: input.auditContext.catId,
            invocationId: input.auditContext.invocationId,
          },
          provider: {
            providerId: 'agy-native',
            method: 'PreToolUse',
            requestId,
            ...(typeof parsed.conversationId === 'string' && parsed.conversationId
              ? { threadId: parsed.conversationId }
              : {}),
          },
          createdAt: Date.now(),
          title: `AGY 请求执行 ${toolName}`,
          description,
          decisions: [
            { id: 'allow_once', label: '允许本次执行', outcome: 'accept' },
            { id: 'reject_once', label: '拒绝', outcome: 'decline' },
            { id: 'cancel', label: '取消', outcome: 'cancel' },
          ],
        },
        { signal },
      );
      const approved = response.kind === 'decision' && response.decisionId === 'allow_once' && !signal.aborted;
      reply(200, {
        approved,
        ...(approved
          ? {}
          : {
              reason: `tool ${toolName} was not approved (${response.kind === 'decision' ? response.decisionId : 'cancelled'})`,
            }),
      });
    } catch (error) {
      reply(200, {
        approved: false,
        reason: error instanceof Error ? error.message : 'interactive approval failed',
      });
    }
  });

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    try {
      rmSync(bridgeFile, { force: true });
    } catch {
      // Best effort cleanup inside ephemeral run directory.
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    writeFileSync(bridgeFile, `${JSON.stringify({ v: 1, url: `http://127.0.0.1:${address.port}/approve`, token })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { bridgeFile, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
