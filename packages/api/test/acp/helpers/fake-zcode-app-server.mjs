#!/usr/bin/env node
/**
 * Native ZCode 0.16.3-shaped app-server fake for adapter contract tests.
 * No jsonrpc field. session/stop is a request (requires id).
 * Clean-home: omit native model; ZCODE_MODEL env is the source of truth.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import {
  AVAILABLE_MODELS,
  isUnsupportedExplicitModel,
  sendAccepted,
  sessionSnapshot,
} from './zcode-0.16.3-fixtures.mjs';

const isolatedHome = process.env.HOME;
const storePath = process.env.ZCODE_FAKE_STORE ?? join(isolatedHome ?? '', '.zcode', 'cli', 'sessions.json');
const logPath = process.env.ZCODE_FAKE_LOG;
const envModel = process.env.ZCODE_MODEL?.trim();
const sessions = new Map();
if (storePath) {
  try {
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    for (const [id, rec] of Object.entries(saved)) sessions.set(id, rec);
  } catch {
    /* empty store */
  }
}

if (isolatedHome) {
  mkdirSync(join(isolatedHome, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(isolatedHome, '.zcode', 'cli', 'hub-isolation-canary'), 'ok');
}

process.stderr.write('{"api_key":"split-');
process.stderr.write('secret-value"}\n');

function persist() {
  if (!storePath) return;
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(Object.fromEntries(sessions), null, 2));
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function logRpc(msg) {
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      id: msg.id ?? null,
      method: msg.method ?? null,
      model: msg.params?.model ?? msg.params?.runtimeModel?.model ?? null,
      revision: msg.params?.runtimeModel?.revision ?? null,
      decision: msg.decision ?? null,
      home: isolatedHome ?? null,
    })}\n`,
  );
}

function emit(sessionId, type, payload = {}) {
  const rec = sessions.get(sessionId);
  rec.seq = (rec.seq ?? 0) + 1;
  const envelope = {
    eventId: `evt_${rec.seq}`,
    sessionId,
    seq: rec.seq,
    timestamp: Date.now(),
    deliveryKind: 'desktop-continuous',
    type,
    payload,
  };
  rec.events = rec.events ?? [];
  rec.events.push({ eventId: envelope.eventId, seq: envelope.seq, timestamp: envelope.timestamp, type });
  persist();
  write({ method: 'session/event', params: envelope });
}

function historyText(rec) {
  return rec.history.map((h) => h.text).join('\n');
}

function readModel(params) {
  return params?.model ?? params?.runtimeModel?.model;
}

const inflight = new Map();
const permissionWaiters = new Map();

async function handle(msg) {
  logRpc(msg);
  const method = msg.method;
  const id = msg.id;
  const params = msg.params ?? {};
  if (method === 'session/create') {
    const explicit = readModel(params);
    if (explicit) {
      write({
        id,
        error: {
          code: -32602,
          message: `Unsupported model ${JSON.stringify(explicit)}. Available models: ${AVAILABLE_MODELS.join(', ')}`,
        },
      });
      return;
    }
    if (!envModel || envModel.includes('/') || envModel.startsWith('{')) {
      write({
        id,
        error: {
          code: -32000,
          message:
            'Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.',
          data: { code: 'model_config_missing' },
        },
      });
      return;
    }
    const sessionId = `sess_${sessions.size + 1}`;
    const rec = {
      history: [],
      cwd: params.workspace?.workspacePath ?? '',
      envModel,
      seq: 0,
      stateRevision: 0,
      events: [],
      createdAt: Date.now(),
    };
    sessions.set(sessionId, rec);
    persist();
    write({ id, result: sessionSnapshot(sessionId, rec) });
    return;
  }
  if (method === 'session/resume') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    if (readModel(params)) {
      write({
        id,
        error: {
          code: -32602,
          message: `Unsupported model ${JSON.stringify(readModel(params))}. Available models: ${AVAILABLE_MODELS.join(', ')}`,
        },
      });
      return;
    }
    persist();
    write({ id, result: sessionSnapshot(params.sessionId, rec) });
    return;
  }
  if (method === 'session/setModel') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    if (isUnsupportedExplicitModel(params.model)) {
      write({
        id,
        error: {
          code: -32602,
          message: `Unsupported model ${JSON.stringify(params.model)}. Available models: ${AVAILABLE_MODELS.join(', ')}`,
        },
      });
      return;
    }
    // A runtimeModel registration from env (adapter -32031 recovery) is accepted
    // and clears the deferred-adapter warning; bare explicit models are not.
    if (params.runtimeModel?.model?.modelId === 'REJECTED') {
      write({
        id,
        error: {
          code: -32000,
          message: 'Model config is missing for explicit session/setModel on a clean Hub home',
          data: { code: 'model_config_missing' },
        },
      });
      return;
    }
    // Full 0.16.3 runtimeModel schema is enforced so a malformed adapter
    // payload fails here instead of green-lighting against the real app-server.
    const rt = params.runtimeModel;
    const schemaOk =
      rt &&
      typeof rt === 'object' &&
      typeof rt.revision === 'string' &&
      Number.isFinite(rt.generatedAt) &&
      rt.model?.providerId === params.model?.providerId &&
      rt.model?.modelId === params.model?.modelId &&
      rt.provider?.providerId === rt.model?.providerId &&
      typeof rt.provider?.kind === 'string' &&
      Array.isArray(rt.provider?.models) &&
      rt.provider.models.some((m) => m?.modelId === rt.model?.modelId);
    if (schemaOk) {
      if (rec.delaySetModel) {
        await new Promise((resolve) => setTimeout(resolve, rec.delaySetModel));
      }
      rec.modelRuntimeRecovered = true;
      write({ id, result: { messages: [] } });
      return;
    }
    write({
      id,
      error: {
        code: -32000,
        message: 'Model config is missing for explicit session/setModel on a clean Hub home',
        data: { code: 'model_config_missing' },
      },
    });
    return;
  }
  if (method === 'session/subscribe') {
    const rec = sessions.get(params.sessionId);
    write({
      id,
      result: { sessionId: params.sessionId, eventSeq: rec?.seq ?? 0, events: [] },
    });
    return;
  }
  if (method === 'session/stop') {
    const pending = inflight.get(params.sessionId);
    if (pending) pending.abort();
    write({ id, result: {} });
    return;
  }
  if (method === 'session/send') {
    const rec = sessions.get(params.sessionId);
    if (!rec) {
      write({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } });
      return;
    }
    const content = String(params.content ?? '');
    if (content.includes('FAIL_SEND')) {
      write({ id, error: { code: -32010, message: 'send failed once' } });
      return;
    }
    if (content.includes('FAIL_MODEL_UNAVAILABLE') && !rec.modelRuntimeRecovered) {
      // Deterministic window for the adapter cancel-during-recovery race test.
      if (content.includes('DELAY_RECOVERY')) rec.delaySetModel = 600;
      if (content.includes('DELAY_SEND_FAIL')) {
        // Deterministic window for cancel-during-first-send: -32031 arrives late.
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      write({
        id,
        error: {
          code: -32031,
          message: '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。',
          data: { code: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE', sessionId: params.sessionId },
        },
      });
      return;
    }
    if (content.includes('HANG_SEND')) {
      return;
    }
    rec.history.push({ role: 'user', text: content });
    rec.stateRevision = (rec.stateRevision ?? 0) + 1;
    persist();
    write({ id, result: sendAccepted(params.sessionId, rec.stateRevision) });
    if (content.includes('EXIT_AFTER_SEND')) {
      process.exit(1);
    }
    const ac = new AbortController();
    inflight.set(params.sessionId, ac);
    emit(params.sessionId, 'turn.started', {});
    if (content.includes('ASK_PERMISSION')) {
      const permId = 900000 + sessions.size;
      const decision = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('permission timeout')), 2000);
        permissionWaiters.set(String(permId), (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        write({
          id: permId,
          method: 'interaction/requestPermission',
          params: {
            requestId: `perm_${permId}`,
            sessionId: params.sessionId,
            toolCallId: 'tool_1',
            toolName: 'read',
            reason: 'contract test',
            riskLevel: 'low',
          },
        });
      });
      logRpc({ method: 'interaction/requestPermission/reply', decision: decision?.decision });
      if (decision?.decision !== 'allow') {
        emit(params.sessionId, 'turn.failed', {
          error: { type: 'PERMISSION_DENIED', message: 'permission was not allow' },
          turnPhase: 'tool',
        });
        inflight.delete(params.sessionId);
        return;
      }
    }
    if (content.includes('FAIL_SECRET')) {
      emit(params.sessionId, 'turn.failed', {
        error: {
          type: 'MISSING_CREDENTIAL',
          message: 'provider rejected sk-secret-LIVEKEY99 Bearer abc.def.ghi ANTHROPIC_API_KEY=supersecret',
        },
        turnPhase: 'model',
      });
      inflight.delete(params.sessionId);
      return;
    }
    if (content.includes('SLEEP_TURN')) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          ac.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { aborted: true }));
          });
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'aborted' in err) {
          emit(params.sessionId, 'turn.completed', { resultType: 'cancelled' });
          inflight.delete(params.sessionId);
          return;
        }
        throw err;
      }
    }
    let reply = 'PONG';
    if (historyText(rec).includes('TOKEN_A') && /what was the token/i.test(content)) {
      reply = 'TOKEN_A';
    } else if (content.includes('TOKEN_A')) {
      reply = 'ok TOKEN_A';
    }
    rec.history.push({ role: 'assistant', text: reply });
    persist();
    emit(params.sessionId, 'model.streaming', { kind: 'text_delta', delta: reply });
    emit(params.sessionId, 'turn.completed', { resultType: 'success' });
    inflight.delete(params.sessionId);
    return;
  }
  if (id != null && method) {
    write({ id, error: { code: -32601, message: `unhandled ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (msg.id != null && msg.result && !msg.method) {
    const waiter = permissionWaiters.get(String(msg.id));
    if (waiter) {
      permissionWaiters.delete(String(msg.id));
      waiter(msg.result);
    }
    continue;
  }
  if (msg.method === 'session/requestRuntimePreferences' && msg.id != null) {
    write({
      id: msg.id,
      result: {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      },
    });
    continue;
  }
  void handle(msg);
}
