import type { PreparedEditorSessionV1 } from './editor-session-service.js';

export interface EditorSurfaceAdmissionV1 {
  readonly v: 1;
  readonly kind: 'f202-content-editor-surface-admission';
  readonly providerId: string;
  readonly installationInstanceId: string;
  readonly providerVersion: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly activationState: 'enabled';
  readonly runtimeState: 'healthy';
  readonly rendererOrigin: string;
  readonly entrypointPath: string;
  readonly surfaceIntegrity: string;
  readonly bridgeVersion: '1.0.0';
  readonly sandbox: 'dedicated-origin-iframe';
  readonly framingPolicy: {
    readonly kind: 'csp-frame-ancestors';
    readonly parentOrigin: string;
  };
  readonly navigationPolicy: 'navigation-api-deny';
}

export interface EditorSurfaceLocatorPort {
  resolve(session: PreparedEditorSessionV1): Promise<unknown>;
}

export function surfaceAdmissionMatchesSession(
  value: unknown,
  session: PreparedEditorSessionV1,
): value is EditorSurfaceAdmissionV1 {
  if (!isRecord(value) || !isRecord(value.framingPolicy)) return false;
  const framingPolicy = value.framingPolicy;
  if (
    value.v !== 1 ||
    value.kind !== 'f202-content-editor-surface-admission' ||
    value.providerId !== session.providerId ||
    value.installationInstanceId !== session.installationInstanceId ||
    value.providerVersion !== session.providerVersion ||
    value.packageDigest !== session.packageDigest ||
    value.grantRevision !== session.grantRevision ||
    value.lifecycleRevision !== session.lifecycleRevision ||
    value.activationState !== 'enabled' ||
    value.runtimeState !== 'healthy' ||
    value.surfaceIntegrity !== session.surfaceIntegrity ||
    value.bridgeVersion !== '1.0.0' ||
    value.sandbox !== 'dedicated-origin-iframe' ||
    value.navigationPolicy !== 'navigation-api-deny' ||
    framingPolicy.kind !== 'csp-frame-ancestors' ||
    typeof framingPolicy.parentOrigin !== 'string' ||
    typeof value.rendererOrigin !== 'string' ||
    typeof value.entrypointPath !== 'string' ||
    typeof value.surfaceIntegrity !== 'string' ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/.test(value.surfaceIntegrity) ||
    !/^\/packages\/[A-Za-z0-9._~-]+\/assets\/[A-Za-z0-9._~/-]+$/.test(value.entrypointPath) ||
    value.entrypointPath.includes('..')
  ) {
    return false;
  }

  const rendererOrigin = parseAllowedOrigin(value.rendererOrigin);
  const parentOrigin = parseAllowedOrigin(framingPolicy.parentOrigin);
  return rendererOrigin !== null && parentOrigin !== null && rendererOrigin !== parentOrigin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAllowedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username !== '' || url.password !== '') return null;
    if (url.protocol === 'https:') return url.origin;
    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname.endsWith('.localhost'))
    ) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}
