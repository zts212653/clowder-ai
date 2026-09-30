import { PluginInventoryError } from './host-inventory/types.js';

export type OfficialPluginInstallErrorCode =
  | 'UNKNOWN_CATALOG_ID'
  | 'PACKAGE_DOWNLOAD_FAILED'
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'PACKAGE_ID_MISMATCH'
  | 'PACKAGE_VERSION_MISMATCH'
  | 'PACKAGE_PRESENTATION_MISMATCH'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_PACKAGE_SCHEMA'
  | 'INVALID_PACKAGE_ARCHIVE'
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_CATALOG'
  | 'STALE_REVISION'
  | 'UPDATE_NOT_NEWER'
  | 'UPDATE_REQUIRES_STOPPED'
  | 'INVENTORY_REJECTED'
  | 'DATA_DIRECTORY_IN_USE'
  | 'QUARANTINE_UNAVAILABLE';

export class OfficialPluginInstallError extends Error {
  constructor(
    readonly code: OfficialPluginInstallErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'OfficialPluginInstallError';
  }
}

/** F202 W2-3 h2: another installed plugin holds the data directory; the owner sees who, nothing is quarantined. */
export function throwDataDirectoryConflict(error: unknown): void {
  if (error instanceof PluginInventoryError && error.code === 'DATA_DIRECTORY_IN_USE') {
    throw new OfficialPluginInstallError('DATA_DIRECTORY_IN_USE', error.message, { cause: error });
  }
}
