import { type QuotaPinPreference, type QuotaPinPreferencePatch, quotaPinPreferenceSchema } from '@cat-cafe/shared';
import { readUserPreferencesStrict, updateUserPreferences } from './user-preferences-store.js';

function normalizeQuotaPin(value: unknown): QuotaPinPreference {
  const parsed = quotaPinPreferenceSchema.safeParse(value ?? {});
  if (!parsed.success) return { pinned: true, selectedAccountRefs: null };
  return {
    pinned: parsed.data.pinned,
    selectedAccountRefs: parsed.data.selectedAccountRefs ? [...new Set(parsed.data.selectedAccountRefs)] : null,
  };
}

export function readQuotaPinPreferenceStrict(projectRoot: string): QuotaPinPreference {
  return normalizeQuotaPin(readUserPreferencesStrict(projectRoot).quotaPin);
}

export function saveQuotaPinPreference(projectRoot: string, patch: QuotaPinPreferencePatch): QuotaPinPreference {
  const updated = updateUserPreferences(
    projectRoot,
    (current) => {
      const existing = normalizeQuotaPin(current.quotaPin);
      const next = normalizeQuotaPin({
        pinned: patch.pinned ?? existing.pinned,
        selectedAccountRefs:
          patch.selectedAccountRefs !== undefined ? patch.selectedAccountRefs : existing.selectedAccountRefs,
      });
      return { ...current, quotaPin: next };
    },
    { strictRead: true },
  );
  return normalizeQuotaPin(updated.quotaPin);
}
