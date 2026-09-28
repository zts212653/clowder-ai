import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import {
  canonicalFootballJson,
  createMicroduckFootballPackageRef,
  footballSha256,
  listMicroduckFootballPackageComponents,
  type MicroduckFootballPackageComponent,
  type MicroduckFootballPackageV1,
  validateMicroduckFootballPackage,
} from './package.js';

export type MicroduckFootballIntegrityBlocked =
  | { readonly status: 'blocked'; readonly code: 'football_package_invalid' }
  | { readonly status: 'blocked'; readonly code: 'football_package_ref_mismatch' }
  | { readonly status: 'blocked'; readonly code: 'football_runtime_incompatible' }
  | {
      readonly status: 'blocked';
      readonly code: 'football_component_unavailable' | 'football_component_drift';
      readonly componentId: string;
    };

export interface MicroduckFootballIntegrityResolved {
  readonly status: 'resolved';
  readonly packageRef: ExactAssetVersionRefV1;
  readonly runtimeAbiRef: OwnerTruthRefV1;
  readonly componentCount: number;
}

export interface MicroduckFootballIntegrityInput {
  readonly package: unknown;
  readonly packageRef: ExactAssetVersionRefV1;
  readonly supportedRuntime: MicroduckFootballPackageV1['runtime'];
  readonly readComponent: (component: MicroduckFootballPackageComponent) => Promise<Uint8Array | undefined>;
}

function exactRefMatches(left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean {
  return (
    left.ownerFeatureId === right.ownerFeatureId &&
    left.ownerStateRef === right.ownerStateRef &&
    left.version === right.version &&
    left.assetKind === right.assetKind &&
    left.assetId === right.assetId
  );
}

const EXPECTED_COMPONENT_IDS = [
  'model:manifest',
  'model:stand',
  'model:walk',
  'model:kick-left',
  'model:kick-right',
  'simulator:scene',
  'simulator:robot-groundcontact',
  'simulator:ball',
  'simulator:infer-policy',
  'controller:approach',
  'controller:arc',
  'controller:path',
  'controller:safety-guard',
  'runtime:runner',
] as const;

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function validSource(component: MicroduckFootballPackageComponent): boolean {
  if (component.source.kind === 'owner_repository') return true;
  if (!/^[a-f0-9]{40}$/u.test(component.source.revision)) return false;
  return component.source.kind === 'model_repository'
    ? component.source.repository === 'pollen-robotics/microduck-policies'
    : component.source.repository === 'pollen-robotics/microduck_rl';
}

function validPackageComponents(
  value: MicroduckFootballPackageV1,
  components: readonly MicroduckFootballPackageComponent[],
): boolean {
  return (
    value.schemaVersion === 1 &&
    value.artifactKind === 'microduck-control-package' &&
    value.capability === 'football' &&
    value.assetId === 'football-forward-arc-csc' &&
    components.length === EXPECTED_COMPONENT_IDS.length &&
    components.every(
      (component, index) =>
        component.id === EXPECTED_COMPONENT_IDS[index] &&
        /^[a-f0-9]{64}$/u.test(component.sha256) &&
        safeRelativePath(component.path) &&
        validSource(component),
    )
  );
}

export function createMicroduckFootballRuntimeAbiRef(runtime: MicroduckFootballPackageV1['runtime']): OwnerTruthRefV1 {
  const digest = footballSha256(canonicalFootballJson(runtime));
  return {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `runtime-abi:sha256:${digest}`,
    version: digest,
  };
}

/** Integrity resolution proves exact bytes and ABI compatibility; it never claims a runtime load. */
export async function inspectMicroduckFootballPackage(
  input: MicroduckFootballIntegrityInput,
): Promise<MicroduckFootballIntegrityResolved | MicroduckFootballIntegrityBlocked> {
  const packageValue = validateMicroduckFootballPackage(input.package);
  if (!packageValue) return { status: 'blocked', code: 'football_package_invalid' };
  let components: MicroduckFootballPackageComponent[];
  let expectedRef: ExactAssetVersionRefV1;
  try {
    components = listMicroduckFootballPackageComponents(packageValue);
    if (!validPackageComponents(packageValue, components)) {
      return { status: 'blocked', code: 'football_package_invalid' };
    }
    expectedRef = createMicroduckFootballPackageRef(packageValue);
  } catch {
    return { status: 'blocked', code: 'football_package_invalid' };
  }
  if (!exactRefMatches(expectedRef, input.packageRef)) {
    return { status: 'blocked', code: 'football_package_ref_mismatch' };
  }
  if (canonicalFootballJson(input.supportedRuntime) !== canonicalFootballJson(packageValue.runtime)) {
    return { status: 'blocked', code: 'football_runtime_incompatible' };
  }

  for (const component of components) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await input.readComponent(component);
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      return { status: 'blocked', code: 'football_component_unavailable', componentId: component.id };
    }
    if (footballSha256(bytes) !== component.sha256) {
      return { status: 'blocked', code: 'football_component_drift', componentId: component.id };
    }
  }

  return {
    status: 'resolved',
    packageRef: expectedRef,
    runtimeAbiRef: createMicroduckFootballRuntimeAbiRef(packageValue.runtime),
    componentCount: components.length,
  };
}
