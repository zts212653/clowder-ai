import { createHash } from 'node:crypto';
import type {
  ContentEditorPluginRuntime,
  PluginContentEditorHandle,
} from '../plugin/content-editor-runtime/runtime.js';
import { HostBrokerError } from '../plugin/host-broker/types.js';
import { authorityMatchesSession } from './editor-session-authority.js';
import {
  type EditorProviderAuthorityPort,
  type EditorProviderAuthorityV1,
  EditorSessionError,
} from './editor-session-service.js';
import type { EditorSurfaceAdmissionV1, EditorSurfaceLocatorPort } from './editor-surface-admission.js';

function authorityFromHandle(handle: PluginContentEditorHandle): EditorProviderAuthorityV1 {
  return {
    providerId: handle.contribution.id,
    installationInstanceId: handle.installationInstanceId,
    providerVersion: handle.providerVersion,
    packageDigest: handle.packageDigest,
    grantRevision: handle.grantRevision,
    lifecycleRevision: handle.lifecycleRevision,
    executionLeaseDigest: `sha256:${createHash('sha256').update(handle.executionLease).digest('hex')}`,
    activationState: 'enabled',
    runtimeState: 'healthy',
    surfaceIntegrity: handle.contribution.surface.integrity,
  };
}

/** F202 owns the live feature lease; F309 retains only its digest and executes
 * owner effects inside that Host authority. No second provider registry exists.
 */
export function createPluginEditorAuthority(runtime: Pick<ContentEditorPluginRuntime, 'resolve' | 'features'>): {
  readonly authority: EditorProviderAuthorityPort;
  readonly surfaces: EditorSurfaceLocatorPort;
} {
  return {
    authority: {
      async resolve(id, providerId) {
        const handle = await runtime.resolve(id, providerId);
        return handle ? authorityFromHandle(handle) : undefined;
      },
      async run(expected, work) {
        const handle = await runtime.resolve(expected.installationInstanceId, expected.providerId);
        if (!handle || !authorityMatchesSession(authorityFromHandle(handle), expected)) {
          throw new EditorSessionError('AUTHORITY_CHANGED', 'Editor feature activation changed');
        }
        try {
          return await runtime.features.run(handle.executionLease, work);
        } catch (error) {
          if (error instanceof HostBrokerError)
            throw new EditorSessionError('AUTHORITY_CHANGED', 'Editor feature authority is unavailable');
          throw error;
        }
      },
    },
    surfaces: {
      async resolve(session): Promise<EditorSurfaceAdmissionV1 | undefined> {
        const handle = await runtime.resolve(session.installationInstanceId, session.providerId);
        if (!handle || !authorityMatchesSession(authorityFromHandle(handle), session)) return undefined;
        return {
          v: 1,
          kind: 'f202-content-editor-surface-admission',
          providerId: handle.contribution.id,
          installationInstanceId: handle.installationInstanceId,
          providerVersion: handle.providerVersion,
          packageDigest: handle.packageDigest,
          grantRevision: handle.grantRevision,
          lifecycleRevision: handle.lifecycleRevision,
          activationState: 'enabled',
          runtimeState: 'healthy',
          rendererOrigin: handle.rendererOrigin,
          entrypointPath: handle.entrypointPath,
          surfaceIntegrity: handle.contribution.surface.integrity,
          bridgeVersion: handle.contribution.bridgeVersion,
          sandbox: handle.contribution.surface.sandbox,
          navigationPolicy: handle.contribution.surface.navigationPolicy,
          framingPolicy: { kind: 'csp-frame-ancestors', parentOrigin: handle.parentOrigin },
        };
      },
    },
  };
}
