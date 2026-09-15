import { createHash, randomUUID } from 'node:crypto';
import type { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import { authorityMatchesBinding, authorityMatchesSession, bindingMatchesSession } from './editor-session-authority.js';
import {
  EditorSessionStateConflictError,
  EditorSessionStore,
  type StoredEditorSessionRecordV1,
} from './editor-session-store.js';
import {
  type EditorProviderAuthorityPort,
  type EditorProviderAuthorityV1,
  EditorSessionError,
  type EditorSessionRecordV1,
  type HostAuthenticatedPrincipalV1,
  type PreparedEditorSessionV1,
} from './editor-session-types.js';
import {
  OfficeProviderBindingConflictError,
  type OfficeProviderBindingStore,
  type OfficeProviderBindingV1,
} from './provider-binding-store.js';

export * from './editor-session-types.js';

export interface EditorSessionServiceOptions {
  readonly dataDir: string;
  readonly bindings: Pick<OfficeProviderBindingStore, 'get' | 'withCurrent'>;
  readonly owner: Pick<ProjectContentOwnerService, 'load'>;
  readonly authority: EditorProviderAuthorityPort;
  readonly createSessionToken?: () => string;
}

export class EditorSessionService {
  private readonly sessions = new Map<string, EditorSessionRecordV1>();
  private readonly tokenByRef = new Map<string, string>();
  private readonly createSessionToken: () => string;
  private readonly store: EditorSessionStore;

  constructor(private readonly options: EditorSessionServiceOptions) {
    this.createSessionToken = options.createSessionToken ?? (() => `editor_${randomUUID()}`);
    this.store = new EditorSessionStore({ dataDir: options.dataDir });
  }

  async issue(input: {
    readonly contentRef: string;
    readonly principal: HostAuthenticatedPrincipalV1;
  }): Promise<EditorSessionRecordV1> {
    validatePrincipal(input.principal);
    const binding = await this.options.bindings.get(input.contentRef);
    if (!binding) {
      throw new EditorSessionError('PROVIDER_UNAVAILABLE', `No Office provider bound for ${input.contentRef}`);
    }
    const authority = await this.resolveCurrentAuthority(binding);
    const content = await this.options.owner.load(input.contentRef);
    const sessionToken = this.createSessionToken();
    const sessionRef = createSessionRef(sessionToken);
    if (this.sessions.has(sessionToken)) throw new Error(`Editor session token collision: ${sessionToken}`);
    if (await this.store.get(sessionRef)) throw new Error(`Editor session ref collision: ${sessionRef}`);
    const session: EditorSessionRecordV1 = {
      sessionRef,
      sessionToken,
      state: 'issued',
      contentRef: input.contentRef,
      actor: { kind: input.principal.kind, actorId: input.principal.subjectId },
      ownerRevision: content.ownerRevision,
      bindingRevision: binding.bindingRevision,
      providerId: binding.providerId,
      installationInstanceId: binding.installationInstanceId,
      providerVersion: binding.providerVersion,
      packageDigest: authority.packageDigest,
      grantRevision: authority.grantRevision,
      lifecycleRevision: authority.lifecycleRevision,
      surfaceIntegrity: authority.surfaceIntegrity,
      executionLeaseDigest: authority.executionLeaseDigest,
    };
    await this.store.put(toStoredSession(session));
    this.remember(session);
    return cloneSession(session);
  }

  async prepareResume(input: {
    readonly sessionRef: string;
    readonly principal: HostAuthenticatedPrincipalV1;
  }): Promise<PreparedEditorSessionV1> {
    validatePrincipal(input.principal);
    const stored = await this.requireStoredSession(input.sessionRef);
    assertPrincipal(stored, input.principal);
    if (stored.state !== 'issued' && stored.state !== 'active') throw stateError(stored);
    await this.assertCurrentAuthority(stored);
    return toPreparedSession(stored);
  }

  async resume(input: {
    readonly sessionRef: string;
    readonly principal: HostAuthenticatedPrincipalV1;
    readonly surfaceIntegrity: string;
  }): Promise<EditorSessionRecordV1> {
    validatePrincipal(input.principal);
    const stored = await this.requireStoredSession(input.sessionRef);
    assertPrincipal(stored, input.principal);
    if (stored.state !== 'issued' && stored.state !== 'active') throw stateError(stored);
    if (input.surfaceIntegrity !== stored.surfaceIntegrity) {
      await this.revoke(stored, 'surface_integrity_mismatch');
      throw new EditorSessionError('SURFACE_INTEGRITY_MISMATCH', 'Renderer integrity did not match session');
    }
    await this.assertCurrentAuthority(stored);
    const sessionToken = this.createRotatedToken(stored);
    const active: EditorSessionRecordV1 = {
      ...toPreparedSession(stored),
      sessionToken,
      state: 'active',
    };
    await this.store.put(toStoredSession(active));
    this.forgetRef(stored.sessionRef);
    this.remember(active);
    return cloneSession(active);
  }

  async activate(input: {
    readonly sessionToken: string;
    readonly surfaceIntegrity: string;
  }): Promise<EditorSessionRecordV1> {
    const session = this.requireSession(input.sessionToken);
    if (session.state !== 'issued') throw stateError(session);
    if (input.surfaceIntegrity !== session.surfaceIntegrity) {
      await this.revoke(session, 'surface_integrity_mismatch');
      throw new EditorSessionError('SURFACE_INTEGRITY_MISMATCH', 'Renderer integrity did not match session');
    }
    await this.assertCurrentAuthority(session);
    const active = { ...session, state: 'active' as const };
    await this.store.put(toStoredSession(active));
    this.remember(active);
    return cloneSession(active);
  }

  async authorize(sessionToken: string): Promise<EditorSessionRecordV1> {
    const session = this.requireSession(sessionToken);
    const stored = await this.requireStoredSession(session.sessionRef);
    if (stored.bearerDigest !== digestToken(sessionToken) || stored.state !== session.state) {
      this.forgetRef(session.sessionRef);
      throw new EditorSessionError('SESSION_REVOKED', 'Editor session bearer has been rotated or revoked');
    }
    if (session.state !== 'active') throw stateError(session);
    await this.assertCurrentAuthority(session);
    return cloneSession(this.requireSession(sessionToken));
  }

  async close(sessionToken: string): Promise<void> {
    const session = this.requireSession(sessionToken);
    if (session.state === 'closed') return;
    const closed = { ...session, state: 'closed' as const };
    await this.store.put(toStoredSession(closed));
    this.remember(closed);
  }

  async run<T>(sessionToken: string, work: (session: EditorSessionRecordV1) => Promise<T>): Promise<T> {
    const session = await this.authorize(sessionToken);
    try {
      return await this.options.authority.run(session, () =>
        this.options.bindings.withCurrent(session, () =>
          this.store.withActive(session.sessionRef, digestToken(sessionToken), () => work(cloneSession(session))),
        ),
      );
    } catch (error) {
      if (error instanceof OfficeProviderBindingConflictError || error instanceof EditorSessionStateConflictError) {
        throw new EditorSessionError('AUTHORITY_CHANGED', 'Editor session authority changed before effect');
      }
      throw error;
    }
  }

  async closeRef(input: {
    readonly sessionRef: string;
    readonly principal: HostAuthenticatedPrincipalV1;
  }): Promise<void> {
    validatePrincipal(input.principal);
    const stored = await this.requireStoredSession(input.sessionRef);
    assertPrincipal(stored, input.principal);
    if (stored.state === 'closed') return;
    await this.store.put({ ...stored, state: 'closed' });
    this.forgetRef(stored.sessionRef);
  }

  inspect(sessionToken: string): EditorSessionRecordV1 | undefined {
    const session = this.sessions.get(sessionToken);
    return session ? cloneSession(session) : undefined;
  }

  private requireSession(sessionToken: string): EditorSessionRecordV1 {
    const session = this.sessions.get(sessionToken);
    if (!session) throw new EditorSessionError('SESSION_NOT_FOUND', `Unknown editor session ${sessionToken}`);
    return session;
  }

  private async requireStoredSession(sessionRef: string): Promise<StoredEditorSessionRecordV1> {
    const session = await this.store.get(sessionRef);
    if (!session) throw new EditorSessionError('SESSION_NOT_FOUND', `Unknown editor session ${sessionRef}`);
    return session;
  }

  private async assertCurrentAuthority(session: PreparedEditorSessionV1): Promise<void> {
    const binding = await this.options.bindings.get(session.contentRef);
    if (!binding || !bindingMatchesSession(binding, session)) {
      await this.revoke(session, 'provider_binding_changed');
      throw new EditorSessionError('AUTHORITY_CHANGED', `Provider binding changed for ${session.contentRef}`);
    }
    const authority = await this.options.authority.resolve(session.installationInstanceId, session.providerId);
    if (!authority || !authorityMatchesSession(authority, session)) {
      await this.revoke(session, 'plugin_authority_changed');
      throw new EditorSessionError('AUTHORITY_CHANGED', 'Plugin authority changed for editor session');
    }
  }

  private async resolveCurrentAuthority(binding: OfficeProviderBindingV1): Promise<EditorProviderAuthorityV1> {
    const authority = await this.options.authority.resolve(binding.installationInstanceId, binding.providerId);
    if (!authority || !authorityMatchesBinding(authority, binding)) {
      throw new EditorSessionError(
        'PROVIDER_UNAVAILABLE',
        `Bound provider ${binding.installationInstanceId} is not enabled and healthy`,
      );
    }
    return authority;
  }

  private async revoke(session: PreparedEditorSessionV1, revokeReason: string): Promise<void> {
    const stored = await this.requireStoredSession(session.sessionRef);
    await this.store.put({ ...stored, state: 'revoked', revokeReason });
    const currentToken = this.tokenByRef.get(session.sessionRef);
    const current = currentToken ? this.sessions.get(currentToken) : undefined;
    if (current) this.sessions.set(current.sessionToken, { ...current, state: 'revoked', revokeReason });
  }

  private createRotatedToken(session: StoredEditorSessionRecordV1): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createSessionToken();
      if (!this.sessions.has(candidate) && digestToken(candidate) !== session.bearerDigest) return candidate;
    }
    throw new Error('Editor session token generator did not produce a fresh bearer');
  }

  private remember(session: EditorSessionRecordV1): void {
    this.sessions.set(session.sessionToken, session);
    this.tokenByRef.set(session.sessionRef, session.sessionToken);
  }

  private forgetRef(sessionRef: string): void {
    const token = this.tokenByRef.get(sessionRef);
    if (token) this.sessions.delete(token);
    this.tokenByRef.delete(sessionRef);
  }
}

function stateError(session: PreparedEditorSessionV1): EditorSessionError {
  if (session.state === 'closed') return new EditorSessionError('SESSION_CLOSED', 'Editor session is closed');
  if (session.state === 'revoked') return new EditorSessionError('SESSION_REVOKED', 'Editor session is revoked');
  return new EditorSessionError('SESSION_NOT_ACTIVE', `Editor session is ${session.state}`);
}

function toStoredSession(session: EditorSessionRecordV1): StoredEditorSessionRecordV1 {
  const { sessionToken, ...prepared } = session;
  return { ...prepared, bearerDigest: digestToken(sessionToken) };
}

function toPreparedSession(session: StoredEditorSessionRecordV1): PreparedEditorSessionV1 {
  const { bearerDigest: _bearerDigest, ...prepared } = session;
  return { ...prepared, actor: { ...prepared.actor } };
}

function cloneSession(session: EditorSessionRecordV1): EditorSessionRecordV1 {
  return { ...session, actor: { ...session.actor } };
}

function createSessionRef(sessionToken: string): string {
  return `editor-session:${createHash('sha256').update(sessionToken).digest('hex')}`;
}

function digestToken(sessionToken: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(sessionToken).digest('hex')}`;
}

function assertPrincipal(session: PreparedEditorSessionV1, principal: HostAuthenticatedPrincipalV1): void {
  if (session.actor.kind !== principal.kind || session.actor.actorId !== principal.subjectId) {
    throw new EditorSessionError('PRINCIPAL_MISMATCH', 'Editor session does not belong to the authenticated principal');
  }
}

function validatePrincipal(principal: HostAuthenticatedPrincipalV1): void {
  if (principal.kind !== 'human' && principal.kind !== 'cat') throw new TypeError('principal kind is invalid');
  if (
    principal.subjectId.length === 0 ||
    principal.subjectId.length > 256 ||
    principal.subjectId.trim() !== principal.subjectId ||
    principal.subjectId.includes('\0')
  ) {
    throw new TypeError('principal subjectId is invalid');
  }
}
