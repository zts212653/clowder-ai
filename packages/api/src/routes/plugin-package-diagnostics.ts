import type { FastifyRequest } from 'fastify';
import {
  LocalPluginPackageAdmissionError,
  PluginArchiveReplacementError,
  PluginLifecycleError,
  PluginManagerServiceError,
} from '../domains/plugin/index.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';
import { PluginManagerUploadError } from './plugin-manager-upload.js';

/** Emit only public error codes and already-validated identities, never the error/cause or request body. */
export function warnPluginPackageFailure(
  request: FastifyRequest,
  context: {
    operation: 'install' | 'update';
    sourceKind?: 'catalog' | 'git' | 'local-directory' | 'local-archive';
    catalogId?: string;
    pluginId?: string;
  },
  error: unknown,
): void {
  const code =
    error instanceof OfficialPluginInstallError ||
    error instanceof LocalPluginPackageAdmissionError ||
    error instanceof PluginArchiveReplacementError ||
    error instanceof PluginLifecycleError ||
    error instanceof PluginManagerServiceError ||
    error instanceof PluginManagerUploadError
      ? error.code
      : 'PLUGIN_MANAGER_FAILED';
  const diagnostic = error instanceof PluginManagerServiceError ? error.diagnostic : undefined;
  // the wrapped reason (e.g. the inventory's CONTRACT_VERSION_MISMATCH behind INVENTORY_REJECTED)
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const causeInfo = cause
    ? { cause: { code: (cause as { code?: unknown }).code, message: cause.message.slice(0, 500) } }
    : {};
  request.log.warn(
    { reqId: request.id, ...context, code, ...diagnostic, ...causeInfo },
    'Plugin package operation failed',
  );
}
