export type OfficialPluginInstallErrorCode =
  | 'UNKNOWN_CATALOG_ID'
  | 'PACKAGE_DOWNLOAD_FAILED'
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'PACKAGE_ID_MISMATCH'
  | 'PACKAGE_VERSION_MISMATCH'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_PACKAGE_SCHEMA'
  | 'INVALID_PACKAGE_ARCHIVE'
  | 'INVENTORY_REJECTED';

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
