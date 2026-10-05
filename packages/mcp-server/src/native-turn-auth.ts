import { readFileSync, statSync } from 'node:fs';
import { withInvocationCredentials } from './tools/invocation-auth.js';

interface Credentials {
  invocationId: string;
  callbackToken: string;
}
interface AdmissionOptions {
  env?: NodeJS.ProcessEnv;
  verify?: (credentials: Credentials, signal: AbortSignal) => Promise<void>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const denied = () => new Error('Native tool admission is unavailable for this exact turn');

function readProjection(file: string): Record<string, unknown> {
  try {
    if (statSync(file).size > 128_000) throw denied();
    return object(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw denied();
  }
}

async function verifyCanonical(env: NodeJS.ProcessEnv, credentials: Credentials, signal: AbortSignal): Promise<void> {
  const origin = env.CAT_CAFE_API_URL;
  if (!origin) throw denied();
  const response = await fetch(new URL('/api/callbacks/native-turn-admission', origin), {
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    redirect: 'error',
  });
  if (response.status !== 204) throw denied();
}

/**
 * Only for Host-owned stdio MCP transports. Codex creates _meta outside model arguments.
 * The file is a credential projection of admitted Host executions, not an authority ledger.
 * Canonical callback verification is required even for tools whose local reader has no HTTP auth.
 */
export async function runWithNativeTurnAuth<T>(
  meta: unknown,
  signal: AbortSignal,
  run: () => Promise<T>,
  options: AdmissionOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const file = env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
  if (!file) return run();
  signal.throwIfAborted();
  const runtime = object(meta);
  const turn = object(runtime['x-codex-turn-metadata']);
  if (!id(runtime.threadId) || runtime.threadId !== turn.thread_id || !id(turn.turn_id)) throw denied();
  const projection = readProjection(file);
  if (
    projection.v !== 1 ||
    !id(env.CAT_CAFE_NATIVE_CONNECTION_ID) ||
    projection.connectionId !== env.CAT_CAFE_NATIVE_CONNECTION_ID ||
    projection.nativeThreadId !== runtime.threadId ||
    !Array.isArray(projection.turns)
  )
    throw denied();
  const matches = projection.turns.map(object).filter((entry) => entry.nativeTurnId === turn.turn_id);
  if (matches.length !== 1) throw denied();
  const entry = matches[0];
  if (!entry || !id(entry.invocationId) || !id(entry.callbackToken)) throw denied();
  const credentials = { invocationId: entry.invocationId, callbackToken: entry.callbackToken };
  await (options.verify ?? ((value, abort) => verifyCanonical(env, value, abort)))(credentials, signal);
  signal.throwIfAborted();
  // A stop/replacement while canonical verification was in flight must not release this request.
  const latest = readProjection(file);
  if (
    latest.connectionId !== projection.connectionId ||
    latest.nativeThreadId !== projection.nativeThreadId ||
    !Array.isArray(latest.turns) ||
    !latest.turns.some((value) => {
      const current = object(value);
      return (
        current.nativeTurnId === turn.turn_id &&
        current.invocationId === credentials.invocationId &&
        current.callbackToken === credentials.callbackToken
      );
    })
  )
    throw denied();
  return withInvocationCredentials(credentials, run);
}
