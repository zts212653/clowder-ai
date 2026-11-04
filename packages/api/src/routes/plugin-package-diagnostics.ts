import type { FastifyRequest } from 'fastify';
import {
  LocalPluginPackageAdmissionError,
  PluginArchiveReplacementError,
  PluginLifecycleError,
  PluginManagerServiceError,
} from '../domains/plugin/index.js';
import { MarketplacePreparationError } from '../domains/plugin/manager/marketplace/git-marketplace-preparation.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';
import { PluginManagerUploadError } from './plugin-manager-upload.js';

/** Emit public codes/identities and explicitly sanitized preparation diagnostics, never raw errors. */
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
  const preparation =
    error instanceof PluginManagerServiceError && error.cause instanceof MarketplacePreparationError
      ? error.cause.diagnostic
      : undefined;
  request.log.warn(
    { reqId: request.id, ...context, code, ...(preparation ? { preparation } : {}) },
    'Plugin package operation failed',
  );
}
