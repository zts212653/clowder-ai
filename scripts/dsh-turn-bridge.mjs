/**
 * Per-launch DSH turn bridge.
 *
 * Runs inside the installed Desktop DSH through its public per-launch plugin
 * seam. It hosts the unmodified official ACP server over an intercepting
 * NDJSON transport and adds one private extension:
 *
 *   _clowder/hello          capability negotiation
 *   _clowder/turn/steer     Agent.steer() into the prompt's native turn
 *   _clowder/turn/status    native read/accepted/unknown facts
 *   _clowder/turn           bridge -> client turn/read notifications
 *
 * The bridge owns no durable state and does not modify DSH, its profile, or
 * the agent loop. Native `user/message` is the only read fact; `inbox/claimed`
 * only binds the prompt's turn. One ACP client may multiplex sessions, so all
 * live state is keyed by session.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const name = 'cat-cafe-dsh-turn';
export const inject = ['acpAppStartup', 'catCafeSecretContent', 'credentials'];
export const DSH_TURN_PROTOCOL = 1;
export const DSH_TURN_METHODS = {
  hello: '_clowder/hello',
  steer: '_clowder/turn/steer',
  status: '_clowder/turn/status',
  event: '_clowder/turn',
};
const PRIVATE_METHODS = new Set(Object.values(DSH_TURN_METHODS));
const MAX_TEXT = 200_000;

/** Concatenate the text blocks of a prompt or native message. ACP uses an
 * array; the installed DSH session event carries one content object. */
export function textOf(content) {
  if (Array.isArray(content))
    return content
      .flatMap((block) => (block && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('');
  return content && content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

/** The ACP prompt text is preserved verbatim by dsh-acp's admission. Only
 * platform line endings are normalized; no prefix, substring or whitespace
 * folding is allowed to bind a shared L0 prefix to the wrong turn. */
function canonical(value) {
  return value.replace(/\r\n/g, '\n');
}

export function promptMatches(promptText, messageContent) {
  const prompt = canonical(promptText);
  return prompt.length > 0 && canonical(textOf(messageContent)) === prompt;
}

/**
 * Pure live state. The plugin wires native events and JSON-RPC into it; tests
 * can drive the same transitions without spawning Electron.
 */
export function createTurnBridgeState({ notify }) {
  const agents = new Map();
  const sessions = new Map();
  const requestSessions = new Map();

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { prompt: null, deliveries: new Map(), rejected: new Set(), lastTurn: undefined };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const emit = (params) => notify({ jsonrpc: '2.0', method: DSH_TURN_METHODS.event, params });

  return {
    onAgent(agent) {
      if (agent && typeof agent === 'object' && typeof agent.session?.id === 'string')
        agents.set(agent.session.id, agent);
    },

    onPromptRequest(requestId, sessionId, content) {
      const state = stateFor(sessionId);
      state.prompt = {
        requestId,
        sessionId,
        text: textOf(content),
        inFlight: true,
        turn: undefined,
        agent: undefined,
        messageId: undefined,
        initialReadSent: false,
      };
      state.deliveries.clear();
      state.rejected.clear();
      state.lastTurn = undefined;
      requestSessions.set(requestId, sessionId);
    },

    onPromptResponse(requestId) {
      const sessionId = requestSessions.get(requestId);
      requestSessions.delete(requestId);
      const state = sessionId ? sessions.get(sessionId) : undefined;
      if (state?.prompt?.requestId === requestId) state.prompt.inFlight = false;
    },

    onInboxClaimed({ agent, message, turn }) {
      const sessionId = agent?.session?.id;
      const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!state?.prompt || state.prompt.turn !== undefined || !state.prompt.inFlight) return null;
      if (!Number.isSafeInteger(turn) || turn < 0) return null;
      // Runtime-context/internal messages also carry role=user; only the
      // user-sourced prompt may bind the turn.
      if (message?.role !== 'user' || message?.source?.kind !== 'user') return null;
      if (!promptMatches(state.prompt.text, message?.content)) return null;
      state.prompt.turn = turn;
      state.prompt.agent = agent;
      state.prompt.messageId = message?.id;
      state.prompt.initialReadSent = false;
      state.lastTurn = turn;
      emit({ sessionId, type: 'turn_started', nativeTurnId: turn });
      return turn;
    },

    onSessionEvent(session, event) {
      const sessionId = session?.header?.id;
      const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!state?.prompt) return null;
      // Installed 0.2.2-rc.1 session events carry the UserMessage directly in
      // event.data (keys: role,id,content,source), not under data.message.
      if (event?.type === 'user/message') {
        const message = event.data;
        if (message?.role !== 'user' || message?.source?.kind !== 'user') return null;
        const id = message?.id;
        if (typeof id !== 'string' || !id) return null;
        if (state.prompt.messageId === id && !state.prompt.initialReadSent) {
          state.prompt.initialReadSent = true;
          emit({ sessionId, type: 'input_read', deliveryId: id, nativeTurnId: state.prompt.turn });
          return id;
        }
        const delivery = state.deliveries.get(id);
        if (!delivery || delivery.read) return null;
        delivery.read = true;
        emit({ sessionId, type: 'input_read', deliveryId: id, nativeTurnId: state.prompt.turn ?? delivery.turn });
        return id;
      }
      if (event?.type === 'turn/end' && state.prompt.turn !== undefined && event.data?.turn === state.prompt.turn) {
        const reason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'unknown';
        emit({ sessionId, type: 'turn_ended', nativeTurnId: state.prompt.turn, reason });
        state.prompt.turn = undefined;
        state.prompt.inFlight = false;
        return reason;
      }
      return null;
    },

    steer({ sessionId, deliveryId, text, expectedTurn }) {
      const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!state?.prompt || !state.prompt.inFlight || state.prompt.turn === undefined || !state.prompt.agent)
        return { accepted: false, reason: 'no_active_turn' };
      if (expectedTurn !== undefined && expectedTurn !== state.prompt.turn)
        return { accepted: false, reason: 'turn_mismatch' };
      if (
        typeof deliveryId !== 'string' ||
        !deliveryId ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > MAX_TEXT
      )
        return { accepted: false, reason: 'invalid_input' };
      const existing = state.deliveries.get(deliveryId);
      if (existing)
        return existing.text === text
          ? { accepted: true, nativeTurnId: existing.turn, deliveryId }
          : { accepted: false, reason: 'duplicate_delivery' };
      try {
        state.prompt.agent.steer({
          role: 'user',
          id: deliveryId,
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        });
      } catch {
        state.rejected.add(deliveryId);
        return { accepted: false, reason: 'provider_rejected' };
      }
      state.deliveries.set(deliveryId, { text, turn: state.prompt.turn, read: false });
      return { accepted: true, nativeTurnId: state.prompt.turn, deliveryId };
    },

    status({ sessionId, deliveryId }) {
      const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!state?.prompt) return { state: 'unknown' };
      const delivery = state.deliveries.get(deliveryId);
      const agent = state.prompt.agent ?? agents.get(sessionId);
      if (delivery?.read) return { state: 'read', nativeTurnId: delivery.turn };
      if (agent) {
        try {
          if (
            typeof agent.session?.deriveMessages === 'function' &&
            agent.session.deriveMessages().some((message) => message?.id === deliveryId)
          )
            return { state: 'read', nativeTurnId: delivery?.turn ?? state.lastTurn };
        } catch {
          /* Derivation is an optimization; the explicit read event remains authoritative. */
        }
        const inbox = agent.inbox;
        const parked = [
          ...(Array.isArray(inbox?.nextStep) ? inbox.nextStep : []),
          ...(Array.isArray(inbox?.nextTurn) ? inbox.nextTurn : []),
        ].some((message) => message?.id === deliveryId);
        if (parked) return { state: 'accepted', nativeTurnId: delivery?.turn ?? state.prompt.turn ?? state.lastTurn };
      }
      if (state.rejected.has(deliveryId)) return { state: 'not_accepted' };
      return { state: 'unknown' };
    },

    hello() {
      return {
        protocol: DSH_TURN_PROTOCOL,
        bridge: name,
        steer: true,
        nativeTurns: true,
      };
    },
  };
}

/**
 * Host the official ACP server behind an intercepting transport and add the
 * private turn extension. Only the reviewed Desktop carrier is admitted by the
 * overlay; anything missing here fails before the member can run.
 */
export async function apply(ctx, config) {
  const nativeScope = config?.nativeScope;
  if (typeof nativeScope !== 'string' || !nativeScope) throw new Error('dsh_turn_native_scope_missing');
  const require = createRequire(join(nativeScope, 'dsh-acp/package.json'));
  const acp = await import(pathToFileURL(join(nativeScope, 'dsh-acp/lib/index.js')).href);
  const { ndJsonStream } = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);

  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const stream = ndJsonStream(Writable.toWeb(outgoing), Readable.toWeb(incoming));
  const state = createTurnBridgeState({
    notify: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  });

  ctx.on('agent/created', ({ agent }) => state.onAgent(agent));
  ctx.on('agent/inbox/claimed', (payload) => state.onInboxClaimed(payload));
  ctx.on('session/event', (session, event) => state.onSessionEvent(session, event));

  const reply = (id, result) => {
    if (id === undefined || id === null) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };

  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      incoming.write(`${line}\n`);
      return;
    }
    const method = message?.method;
    if (!PRIVATE_METHODS.has(method)) {
      if (method === 'session/prompt' && typeof message.params?.sessionId === 'string') {
        state.onPromptRequest(message.id, message.params.sessionId, message.params.prompt);
      }
      incoming.write(`${line}\n`);
      return;
    }
    if (method === DSH_TURN_METHODS.hello) reply(message.id, state.hello());
    else if (method === DSH_TURN_METHODS.steer) reply(message.id, state.steer(message.params ?? {}));
    else if (method === DSH_TURN_METHODS.status) reply(message.id, state.status(message.params ?? {}));
  });
  reader.on('close', () => incoming.end());
  ctx.effect(
    () => () => {
      reader.close();
      incoming.end();
    },
    'dsh-turn.stdin',
  );

  const output = createInterface({ input: outgoing });
  output.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message?.method === undefined && message?.id !== undefined) state.onPromptResponse(message.id);
    } catch {
      /* Forward non-JSON bytes unchanged; the ACP client owns validation. */
    }
    process.stdout.write(`${line}\n`);
  });
  output.on('close', () => incoming.end());
  ctx.effect(() => () => output.close(), 'dsh-turn.stdout');

  await ctx.plugin(acp, {
    provider: config.provider,
    model: config.model,
    stream,
  });
}
