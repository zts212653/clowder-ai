export type PluginManagerPackageAssetErrorCode =
  | 'PLUGIN_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'CATALOG_UNAVAILABLE'
  | 'INVALID_ASSET';

export class PluginManagerPackageAssetError extends Error {
  constructor(
    readonly code: PluginManagerPackageAssetErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'PluginManagerPackageAssetError';
  }
}

export interface PluginManagerPackageAsset {
  readonly bytes: Buffer;
  readonly contentType: 'image/png' | 'image/svg+xml';
  readonly etag: string;
}

export interface PluginManagerPackageAssetPort {
  readIcon(pluginId: string): Promise<PluginManagerPackageAsset>;
}

export interface PluginManagerPackageDocumentationPort {
  readReadme(pluginId: string): Promise<string | undefined>;
}
