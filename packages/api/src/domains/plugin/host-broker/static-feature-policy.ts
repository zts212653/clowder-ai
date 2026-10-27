import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { desktopWindowContribution } from '../desktop-window-runtime/admission.js';
import { HostBrokerError } from './types.js';

export type StaticFeatureAdmission = 'content-editor' | 'desktop-companion';
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
  if (!feature || feature.resources.length !== 0)
    throw new HostBrokerError('AUTHORITY_CHANGED', 'feature is not a declared static feature');
  const references = feature.contributions ?? [];
  if (references.some((r) => r.type !== 'content-editor-provider'))
    throw new HostBrokerError('AUTHORITY_CHANGED', 'unsupported static feature contribution');
  return references.map((r) => r.id);
}
