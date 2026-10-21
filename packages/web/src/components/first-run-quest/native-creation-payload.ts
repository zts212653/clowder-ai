import type { HubCatEditorFormState } from '../hub-cat-editor.model';
import { buildCatPayload } from '../hub-cat-editor.payload';
import { normalizeMemberDraftForm } from '../settings/members/member-carrier-compat';

/** Preserve the exact pre-canonical request body until its original creation key is acknowledged. */
export function buildNativeCreationPayload(form: HubCatEditorFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = buildCatPayload(normalizeMemberDraftForm(form));
  if (form.carrier !== undefined) return payload;
  delete payload.carrier;
  const legacy = form as HubCatEditorFormState & { acpEnabled?: boolean; codexCarrier?: string };
  if (form.clientId === 'openai' && !legacy.acpEnabled && legacy.codexCarrier) {
    payload.cli = { ...(payload.cli as Record<string, unknown> | undefined), carrier: legacy.codexCarrier };
  }
  return payload;
}
