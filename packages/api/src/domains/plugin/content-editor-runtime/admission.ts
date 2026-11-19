import type {
  ContentEditorProviderContribution,
  ContentPreviewProviderContribution,
  PluginManifest,
} from '@clowder-ai/plugin-contract';

export type StaticContentProviderContribution = ContentEditorProviderContribution | ContentPreviewProviderContribution;

export function isStaticContentProviderType(type: string): type is StaticContentProviderContribution['type'] {
  return type === 'content-editor-provider' || type === 'content-preview-provider';
}

/** Narrow Host transport class. No package module, executable entrypoint, config,
 * credentials, signals, data namespace, or other contribution is admitted here.
 * Public validateManifest owns structural and feature-reference validation.
 */
export function staticContentProviderContributions(
  manifest: PluginManifest,
): readonly StaticContentProviderContribution[] {
  const contributions = manifest.contributions ?? [];
  if (
    manifest.runtime?.transport !== 'builtin' ||
    manifest.runtime.entrypoint !== undefined ||
    (manifest.configuration?.length ?? 0) !== 0 ||
    (manifest.data?.length ?? 0) !== 0 ||
    manifest.signals !== undefined ||
    contributions.length === 0 ||
    contributions.some((item) => !isStaticContentProviderType(item.type)) ||
    manifest.features.some(
      (feature) =>
        feature.resources.length !== 0 ||
        (feature.contributions?.length ?? 0) === 0 ||
        feature.contributions?.some((item) => !isStaticContentProviderType(item.type)),
    )
  ) {
    return [];
  }
  return contributions.filter((item): item is StaticContentProviderContribution =>
    isStaticContentProviderType(item.type),
  );
}

export function staticEditorContributions(manifest: PluginManifest): readonly ContentEditorProviderContribution[] {
  return staticContentProviderContributions(manifest).filter(
    (item): item is ContentEditorProviderContribution => item.type === 'content-editor-provider',
  );
}
