/**
 * App-setting eligibility — the single fail-closed boundary deciding which
 * Hub-persisted settings may travel through the config-root .env.
 *
 * Two consumers share this one list:
 * - `config/project-env-loader.ts` reapplies these keys at API boot
 * - `routes/config.ts` persists them when PATCH /api/config writes an env key
 *
 * Why a hand-maintained allowlist instead of "every hot-updatable ConfigStore
 * key": the config-root .env is operator-writable through the Hub, while
 * process.env is the launcher's privilege channel. Deriving eligibility from
 * the store's key list would let a project file re-arm the capability and
 * permission keys the launcher owns (CAT_CODEX_SANDBOX_MODE,
 * CAT_CODEX_APPROVAL_POLICY, CODEX_AUTH_MODE, CAT_CODEX_EXEC_MODEL,
 * CAT_CODEX_PASS_MODEL_ARG, ...). Those stay hot-update-only at runtime,
 * exactly as they behaved before this feature existed: a restart returns them
 * to whatever the launcher configured. Adding a key here is a deliberate act,
 * not an automatic consequence of a key becoming hot-updatable.
 */

import { configStore } from './ConfigStore.js';

/**
 * ConfigStore keys that are Hub-persisted *app settings*: user-facing display
 * behaviour with no capability or privilege effect.
 *
 * Deliberately excludes `cli.*` / `codex.execution.*` / `a2a.maxDepth` /
 * `cli.timeoutMs`: those are runtime execution parameters, not display
 * settings, and persisting them would change their restart semantics.
 */
export const APP_SETTING_CONFIG_KEYS: ReadonlySet<string> = new Set(['ui.bubble.thinking', 'ui.bubble.cliOutput']);

/**
 * App-setting env keys that no ConfigStore key maps to — the Hub persists them
 * through dedicated routes instead:
 * - `DEFAULT_CAT_ID` — PUT /api/config/default-cat. Read back by
 *   getDefaultCatId(); without reapplication the default cat falls back to
 *   breeds[0] after every restart.
 * - `PROMPT_CAPTURE` / `PROMPT_CAPTURE_CATS` — PATCH /api/config/env
 *   (runtimeEditable, non-sensitive diagnostics). Read back from process.env by
 *   routes/prompt-captures.ts, so without reapplication the switch silently
 *   reverts to 'off' after a restart while the Hub's env-summary still reports
 *   the persisted value.
 */
export const EXTRA_APP_SETTING_ENV_KEYS: ReadonlySet<string> = new Set([
  'DEFAULT_CAT_ID',
  'PROMPT_CAPTURE',
  'PROMPT_CAPTURE_CATS',
]);

/**
 * process.env names eligible for boot restore and .env persistence.
 *
 * Fail-closed: a ConfigStore key that is not listed in APP_SETTING_CONFIG_KEYS
 * never contributes its env name, even though it is hot-updatable.
 */
export function appSettingEnvKeys(): Set<string> {
  const keys = new Set<string>(EXTRA_APP_SETTING_ENV_KEYS);
  for (const configKey of APP_SETTING_CONFIG_KEYS) {
    const envKey = configStore.getEnvKey(configKey);
    if (envKey) keys.add(envKey);
  }
  return keys;
}
