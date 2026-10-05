import type { Capability, PluginManifest } from '@clowder-ai/plugin-contract';
import { desktopWindowContribution } from '../desktop-window-runtime/admission.js';
import { HostBrokerError } from './types.js';

export type StaticFeatureAdmission = 'content-editor' | 'desktop-companion';
export type StaticFeatureGrants = [] | ['windows.create'];

export function staticFeatureGrants(admission: StaticFeatureAdmission): StaticFeatureGrants {
  return admission === 'desktop-companion' ? ['windows.create'] : [];
}

export function matchesStaticFeatureGrants(admission: StaticFeatureAdmission, grants: readonly Capability[]): boolean {
  const expected = staticFeatureGrants(admission);
  return grants.length === expected.length && grants.every((grant, i) => grant === expected[i]);
}

export function staticFeatureDeclarations(
  admission: StaticFeatureAdmission,
  manifest: PluginManifest,
  featureId: string,
): string[] {
  const feature = manifest.features.find((r) => r.id === featureId);
  if (admission === 'desktop-companion') {
    const window = desktopWindowContribution(manifest);
    if (!window || !feature) throw new HostBrokerError('AUTHORITY_CHANGED', 'unsupported desktop companion feature');
    return [window.id];
  }
  if (!feature || feature.resources.length !== 0 || feature.capabilities.length !== 0)
    throw new HostBrokerError('AUTHORITY_CHANGED', 'feature is not a declared zero-capability static feature');
  const references = feature.contributions ?? [];
  if (references.some((r) => r.type !== 'content-editor-provider'))
    throw new HostBrokerError('AUTHORITY_CHANGED', 'unsupported static feature contribution');
  return references.map((r) => r.id);
}
