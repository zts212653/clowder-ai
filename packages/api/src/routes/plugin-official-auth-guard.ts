import type {
  OfficialPluginAuthPort,
  OfficialPluginAuthProjection,
  OfficialPluginAuthTarget,
} from '../domains/plugin/official-plugin-auth.js';

const AUTH_STATUS_FAILED_MESSAGE = '飞书认证状态暂时无法验证，请稍后重试。';

export interface OfficialPluginAuthFailure {
  readonly statusCode: 409 | 502 | 503;
  readonly body: {
    readonly status?: 'failed';
    readonly error: string;
    readonly code: 'AUTH_REQUIRED' | 'AUTH_STATUS_FAILED' | 'AUTH_UNAVAILABLE';
  };
}

export function officialPluginAuthStatusFailure(projection?: OfficialPluginAuthProjection): OfficialPluginAuthFailure {
  return {
    statusCode: 502,
    body: {
      status: 'failed',
      error: projection?.error ?? AUTH_STATUS_FAILED_MESSAGE,
      code: 'AUTH_STATUS_FAILED',
    },
  };
}

export function isOfficialPluginAuthStatusFailure(projection: OfficialPluginAuthProjection): boolean {
  return projection.status === 'failed' && projection.failureKind === 'status_probe';
}

export async function checkOfficialPluginConnectedAuth(
  auth: OfficialPluginAuthPort | undefined,
  target: OfficialPluginAuthTarget,
  requiredMessage: string,
): Promise<{ readonly connected: true } | { readonly connected: false; readonly failure: OfficialPluginAuthFailure }> {
  if (!auth) {
    return {
      connected: false,
      failure: {
        statusCode: 503,
        body: {
          error: 'Official plugin authentication is unavailable',
          code: 'AUTH_UNAVAILABLE',
        },
      },
    };
  }
  let projection: OfficialPluginAuthProjection;
  try {
    projection = await auth.status(target);
  } catch {
    return { connected: false, failure: officialPluginAuthStatusFailure() };
  }
  if (projection.status === 'connected') return { connected: true };
  if (isOfficialPluginAuthStatusFailure(projection)) {
    return { connected: false, failure: officialPluginAuthStatusFailure(projection) };
  }
  return {
    connected: false,
    failure: {
      statusCode: 409,
      body: { error: requiredMessage, code: 'AUTH_REQUIRED' },
    },
  };
}
