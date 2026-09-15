import type { EditorProviderAuthorityV1, PreparedEditorSessionV1 } from './editor-session-service.js';
import type { OfficeProviderBindingV1 } from './provider-binding-store.js';

export function authorityMatchesBinding(
  authority: EditorProviderAuthorityV1,
  binding: OfficeProviderBindingV1,
): boolean {
  return (
    authority.providerId === binding.providerId &&
    authority.installationInstanceId === binding.installationInstanceId &&
    authority.providerVersion === binding.providerVersion &&
    authority.activationState === 'enabled' &&
    authority.runtimeState === 'healthy' &&
    authority.packageDigest.length > 0 &&
    authority.surfaceIntegrity.length > 0 &&
    typeof authority.executionLeaseDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(authority.executionLeaseDigest) &&
    Number.isSafeInteger(authority.grantRevision) &&
    authority.grantRevision > 0 &&
    Number.isSafeInteger(authority.lifecycleRevision) &&
    authority.lifecycleRevision > 0
  );
}

export function authorityMatchesSession(
  authority: EditorProviderAuthorityV1,
  session: PreparedEditorSessionV1,
): boolean {
  return (
    authorityMatchesBinding(authority, session) &&
    authority.packageDigest === session.packageDigest &&
    authority.grantRevision === session.grantRevision &&
    authority.lifecycleRevision === session.lifecycleRevision &&
    authority.surfaceIntegrity === session.surfaceIntegrity &&
    authority.executionLeaseDigest === session.executionLeaseDigest
  );
}

export function bindingMatchesSession(binding: OfficeProviderBindingV1, session: PreparedEditorSessionV1): boolean {
  return (
    binding.contentRef === session.contentRef &&
    binding.bindingRevision === session.bindingRevision &&
    binding.providerId === session.providerId &&
    binding.installationInstanceId === session.installationInstanceId &&
    binding.providerVersion === session.providerVersion
  );
}
