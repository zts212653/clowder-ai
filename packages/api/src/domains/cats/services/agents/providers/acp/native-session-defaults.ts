import { applySessionConfiguration, type SessionConfigurationClient } from './session-configuration.js';

type Session = { sessionId: string; configOptions?: unknown };
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
function currentPreferences(session: Session): Preferences {
  const result: Preferences = {};
  if (!Array.isArray(session.configOptions)) return result;
  for (const option of session.configOptions) {
    if (!option || typeof option !== 'object' || typeof option.currentValue !== 'string') continue;
    if (option.category === 'model' || option.id === 'model') result.model = option.currentValue;
    if (option.category === 'thought_level' || option.id === 'reasoning_effort') result.effort = option.currentValue;
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
  cache(client).set(key(cwd), currentPreferences(session));
  const selected = model ? await applySessionConfiguration(client, session, { model }) : session;
  const result = currentPreferences(selected);
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
