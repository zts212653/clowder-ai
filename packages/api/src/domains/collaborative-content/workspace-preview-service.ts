import { extname } from 'node:path';
import { staticContentProviderContributions } from '../plugin/content-editor-runtime/admission.js';
import type { ContentEditorPluginRuntime } from '../plugin/content-editor-runtime/runtime.js';
import type { PluginInventoryStore } from '../plugin/host-inventory/ports.js';

export class WorkspacePreviewSelectionError extends Error {}

export class WorkspacePreviewService {
  constructor(
    private readonly options: {
      readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
      readonly runtime: Pick<ContentEditorPluginRuntime, 'resolvePreview'>;
      readonly readSource: (worktreeId: string, path: string) => Promise<Buffer>;
    },
  ) {}

  async open({ worktreeId, path }: { worktreeId: string; path: string }) {
    const extension = extname(path).slice(1).toLowerCase();
    const snapshot = await this.options.inventory.snapshot({ currentOnly: true });
    const candidates = snapshot.instances.flatMap((instance) => {
      if (instance.lifecycleState !== 'installed' || instance.activationState !== 'enabled') return [];
      const manifest = snapshot.packages.find((item) => item.packageDigest === instance.packageDigest)?.manifest;
      if (!manifest) return [];
      return staticContentProviderContributions(manifest).flatMap((contribution) => {
        if (contribution.type !== 'content-preview-provider') return [];
        return contribution.formats
          .filter((format) => format.extension === extension)
          .map(() => ({ instanceId: instance.pluginInstanceId, contributionId: contribution.id }));
      });
    });
    if (candidates.length > 1)
      throw new WorkspacePreviewSelectionError('More than one preview format is enabled for this extension');
    const selected = candidates[0];
    if (!selected) return null;
    const bytes = await this.options.readSource(worktreeId, path);
    const surface = await this.options.runtime.resolvePreview(selected.instanceId, selected.contributionId);
    const format = surface?.contribution.formats.find((item) => item.extension === extension);
    if (!surface || !format) return null;
    return {
      rendererOrigin: surface.rendererOrigin,
      entrypointPath: surface.entrypointPath,
      bridgeVersion: surface.contribution.bridgeVersion,
      fileName: path.split('/').at(-1) || path,
      mediaType: format.mediaType,
      bytesBase64: bytes.toString('base64'),
    };
  }
}
