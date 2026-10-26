import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { PluginPackageProvenance } from '../../host-inventory/types.js';

/** Verified executable tree with its locked runtime dependencies available to Node. */
export interface MaterializedBuiltinPluginPackage {
  readonly rootDir: string;
  readonly dependencyRoot?: string;
  readonly manifest: PluginManifest;
  verifyIntegrity(): Promise<void>;
  release(): Promise<void>;
}

/** Type-only consumers must not pull the Node materializer implementation into Console builds. */
export interface BuiltinPluginPackageMaterializer {
  resolve(input: {
    readonly pluginInstanceId: string;
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly packageName?: string;
    readonly sourceKind: PluginPackageProvenance['kind'];
  }): Promise<MaterializedBuiltinPluginPackage>;
}
