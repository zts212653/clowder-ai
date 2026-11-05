import { nativeToolIdentityFor } from '@cat-cafe/shared';
import type { HubCatEditorFormState } from '../hub-cat-editor.model';
import type { RuntimeChoice } from '../settings/members/member-runtime-draft';

/**
 * Replace fields that still carry a known pre-identity default. A field the
 * user edited (or a template that already produced the new identity) is left
 * untouched, so this is safe to run on every onboarding restore and every
 * existing-member reconcile.
 */
export function repairLegacyNativeIdentityFields(
  current: HubCatEditorFormState,
  recommended: HubCatEditorFormState,
  runtime: RuntimeChoice,
): Partial<HubCatEditorFormState> {
  const identity = nativeToolIdentityFor({
    clientId: runtime.clientId,
    catId: runtime.id,
    acp: runtime.acp,
  });
  if (!identity) return {};
  const legacy = identity.legacy;
  const changes: Partial<HubCatEditorFormState> = {};

  const nameIsLegacy =
    (current.name === legacy.name && current.displayName === legacy.name) || (!current.name && !current.displayName);
  if (nameIsLegacy) {
    if (recommended.name && recommended.name !== current.name) changes.name = recommended.name;
    if (recommended.displayName && recommended.displayName !== current.displayName)
      changes.displayName = recommended.displayName;
  }

  if ((!current.nickname || current.nickname === legacy.nickname) && recommended.nickname !== current.nickname) {
    changes.nickname = recommended.nickname;
  }

  if ((!current.avatar?.trim() || current.avatar === legacy.avatar) && recommended.avatar?.trim()) {
    if (recommended.avatar !== current.avatar) changes.avatar = recommended.avatar;
  }

  for (const field of ['roleDescription', 'personality', 'teamStrengths'] as const) {
    const value = current[field];
    if (value === legacy[field] && recommended[field] && recommended[field] !== value) {
      changes[field] = recommended[field];
    }
  }

  return changes;
}

export function withLegacyNativeIdentityRepair(
  current: HubCatEditorFormState,
  recommended: HubCatEditorFormState,
  runtime: RuntimeChoice,
): HubCatEditorFormState {
  const changes = repairLegacyNativeIdentityFields(current, recommended, runtime);
  return Object.keys(changes).length > 0 ? { ...current, ...changes } : current;
}
