import type { ContentEditorProviderContribution, PluginManifest } from '@clowder-ai/plugin-contract';

/** Narrow Host transport class. No package module, executable entrypoint, config,
 * credentials, signals, data namespace, or other contribution is admitted here.
 * Public validateManifest owns structural and feature-reference validation.
 */
export function staticEditorContributions(manifest: PluginManifest): readonly ContentEditorProviderContribution[] {
  const contributions = manifest.contributions ?? [];
  if (
    manifest.runtime.transport !== 'builtin' ||
    manifest.runtime.entrypoint !== undefined ||
    (manifest.configuration?.length ?? 0) !== 0 ||
    (manifest.data?.length ?? 0) !== 0 ||
    manifest.signals !== undefined ||
    contributions.length === 0 ||
    contributions.some((item) => item.type !== 'content-editor-provider') ||
    manifest.features.some(
      (feature) =>
        feature.capabilities.length !== 0 ||
        feature.resources.length !== 0 ||
        (feature.contributions?.length ?? 0) === 0 ||
        feature.contributions?.some((item) => item.type !== 'content-editor-provider'),
    )
  ) {
    return [];
  }
  return contributions.filter(
    (item): item is ContentEditorProviderContribution => item.type === 'content-editor-provider',
  );
}
