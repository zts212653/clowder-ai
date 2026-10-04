import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface NamedAlphaCoordinates {
  readonly v: 1;
  readonly instance: string;
  readonly mainRoot: string;
  readonly alphaRoot: string;
  readonly branch: string;
  readonly ports: {
    readonly frontend: number;
    readonly api: number;
    readonly preview: number;
    readonly service: number;
    readonly redis: number;
  };
  readonly targetSha: string;
}

export interface NamedAlphaRuntimeBoundary {
  readonly coordinates: NamedAlphaCoordinates;
  /** Reuses the canonical producer's current Git/build/path/environment validator. */
  isCurrent(): boolean;
}

interface CanonicalAlphaModule {
  readonly ALPHA_COORDINATE_VERSION: 1;
  validateNamedAlphaEnvironment(env: NodeJS.ProcessEnv, installationRoot: string): NamedAlphaCoordinates;
}

/** Source and dist keep the same depth. Never select executable code from an environment-supplied root. */
const INSTALLATION_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function loadCanonicalAlphaModule(): Promise<CanonicalAlphaModule> {
  const path = resolve(INSTALLATION_ROOT, 'scripts/lib/alpha-coordinates.mjs');
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error('Alpha coordinate validator must belong to this exact installation');
  }
  const module: unknown = await import(pathToFileURL(path).href);
  if (
    !module ||
    typeof module !== 'object' ||
    !('ALPHA_COORDINATE_VERSION' in module) ||
    module.ALPHA_COORDINATE_VERSION !== 1 ||
    !('validateNamedAlphaEnvironment' in module) ||
    typeof module.validateNamedAlphaEnvironment !== 'function'
  ) {
    throw new Error('Unsupported canonical Alpha coordinate validator');
  }
  return module as CanonicalAlphaModule;
}

/** The envelope describes coordinates. Actual current facts still decide whether this Alpha can manage its Service. */
export async function resolveNamedAlphaRuntimeBoundary(
  env: NodeJS.ProcessEnv,
): Promise<NamedAlphaRuntimeBoundary | undefined> {
  if (env.CAT_CAFE_ALPHA_COORDINATES === undefined) return undefined;
  if (env.CAT_CAFE_DEPLOYMENT_ID !== 'alpha') throw new Error('Named Alpha requires the Alpha deployment identity');
  const module = await loadCanonicalAlphaModule();
  const coordinates = module.validateNamedAlphaEnvironment(env, INSTALLATION_ROOT);
  return {
    coordinates,
    isCurrent() {
      try {
        const current = module.validateNamedAlphaEnvironment(env, INSTALLATION_ROOT);
        return JSON.stringify(current) === JSON.stringify(coordinates);
      } catch {
        return false;
      }
    },
  };
}
