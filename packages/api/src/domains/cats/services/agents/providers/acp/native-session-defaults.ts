import {
  applySessionConfiguration,
  replayableSessionPreferences,
  type SessionConfigurationClient,
} from './session-configuration.js';

type Session = { sessionId: string; configOptions?: unknown; models?: unknown };
type Preferences = { model?: string; effort?: string };
// A concrete client belongs to one spawn generation (account + profile). Cwd and
// requested model are separate cache keys; no defaults cross identities/workspaces.
const defaults = new WeakMap<SessionConfigurationClient, Map<string, Preferences>>();

function key(cwd: string, model?: string) {
  return JSON.stringify([cwd, model || '']);
}
function cache(client: SessionConfigurationClient) {
  let result = defaults.get(client);
  if (!result) {
    result = new Map();
    defaults.set(client, result);
  }
  return result;
}
/** Called only on an untouched session/new result, before role effort overrides. */
export async function captureNativeDefaults(
  client: SessionConfigurationClient,
  session: Session,
  cwd: string,
  model?: string,
) {
  cache(client).set(key(cwd), replayableSessionPreferences(session));
  const selected = model ? await applySessionConfiguration(client, session, { model }) : session;
  const result = replayableSessionPreferences(selected);
  cache(client).set(key(cwd, model), result);
  return result;
}

export async function defaultsForNativeResume(
  client: SessionConfigurationClient,
  cwd: string,
  preferences: Preferences,
  probe: () => Promise<Session>,
): Promise<Preferences> {
  if (preferences.model && preferences.effort) return {};
  const existing = cache(client).get(key(cwd, preferences.model));
  if (existing) return existing;
  // ACP has no universal "clear override". A prompt-free session reports native
  // defaults; the caller subsequently loads the original conversation, never
  // adopting this diagnostic session as its history or prompt target.
  const session = await probe();
  try {
    return await captureNativeDefaults(client, session, cwd, preferences.model);
  } finally {
    await client.closeSession?.(session.sessionId);
  }
}
