import { createHash } from 'node:crypto';
import { staticEditorContributions } from '../plugin/content-editor-runtime/admission.js';
import type { ContentEditorPluginRuntime } from '../plugin/content-editor-runtime/runtime.js';
import type { PluginInventoryStore } from '../plugin/host-inventory/ports.js';
import {
  ContentOwnerConflictError,
  ContentOwnerNotFoundError,
  type ProjectContentOwnerService,
} from '../video-studio/content-owner/service.js';
import { DOCX_MEDIA_TYPE } from './editor-bridge/service.js';
import type { EditorSessionService, HostAuthenticatedPrincipalV1 } from './editor-session-service.js';
import { OfficeProviderBindingConflictError, type OfficeProviderBindingStore } from './provider-binding-store.js';

export class WorkspaceEditorUnavailableError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_FORMAT'
      | 'PLUGIN_NOT_INSTALLED'
      | 'PLUGIN_DISABLED'
      | 'PLUGIN_STOPPED'
      | 'PROVIDER_SELECTION_REQUIRED',
  ) {
    super(code);
    this.name = 'WorkspaceEditorUnavailableError';
  }
}

export class WorkspaceEditorService {
  constructor(
    private readonly options: {
      readonly owner: ProjectContentOwnerService;
      readonly ownerUserId: string;
      readonly bindings: OfficeProviderBindingStore;
      readonly sessions: EditorSessionService;
      readonly inventory: PluginInventoryStore;
      readonly runtime: Pick<ContentEditorPluginRuntime, 'resolve'>;
      readonly readSource: (worktreeId: string, path: string) => Promise<Buffer>;
    },
  ) {}

  async open(input: {
    readonly worktreeId: string;
    readonly path: string;
    readonly principal: HostAuthenticatedPrincipalV1;
  }) {
    const contentRef = this.contentRef(input);
    const existingBinding = await this.options.bindings.get(contentRef);
    const snapshot = await this.options.inventory.snapshot();
    const candidates = snapshot.instances
      .filter((instance) => instance.lifecycleState === 'installed')
      .flatMap((instance) => {
        const pkg = snapshot.packages.find((value) => value.packageDigest === instance.packageDigest);
        if (!pkg) return [];
        return staticEditorContributions(pkg.manifest)
          .filter((value) => value.mediaTypes.includes(DOCX_MEDIA_TYPE))
          .map((contribution) => ({ instance, pkg, contribution }));
      });
    const previousPluginId = existingBinding
      ? snapshot.instances.find((value) => value.pluginInstanceId === existingBinding.installationInstanceId)?.pluginId
      : undefined;
    const matches = existingBinding
      ? candidates.filter(
          (value) =>
            value.instance.pluginId === previousPluginId && value.contribution.id === existingBinding.providerId,
        )
      : candidates;
    if (!matches.length) throw new WorkspaceEditorUnavailableError('PLUGIN_NOT_INSTALLED');
    if (matches.length > 1) throw new WorkspaceEditorUnavailableError('PROVIDER_SELECTION_REQUIRED');
    const selected = matches[0]!;
    if (selected.instance.activationState !== 'enabled') throw new WorkspaceEditorUnavailableError('PLUGIN_DISABLED');
    if (!(await this.options.runtime.resolve(selected.instance.pluginInstanceId, selected.contribution.id))) {
      throw new WorkspaceEditorUnavailableError('PLUGIN_STOPPED');
    }
    try {
      await this.options.owner.load(contentRef);
    } catch (error) {
      if (!(error instanceof ContentOwnerNotFoundError)) throw error;
      const bytes = await this.options.readSource(input.worktreeId, input.path);
      try {
        await this.options.owner.importContent({
          contentRef,
          bytes,
          mediaType: DOCX_MEDIA_TYPE,
          actor: { kind: input.principal.kind, actorId: input.principal.subjectId },
          operationId: `import:${contentRef}`,
        });
      } catch (conflict) {
        if (!(conflict instanceof ContentOwnerConflictError)) throw conflict;
      }
    }
    if (
      !existingBinding ||
      existingBinding.installationInstanceId !== selected.instance.pluginInstanceId ||
      existingBinding.providerVersion !== selected.pkg.version
    ) {
      try {
        await this.options.bindings.bind({
          contentRef,
          providerId: selected.contribution.id,
          installationInstanceId: selected.instance.pluginInstanceId,
          providerVersion: selected.pkg.version,
          expectedBindingRevision: existingBinding?.bindingRevision ?? 0,
        });
      } catch (conflict) {
        if (!(conflict instanceof OfficeProviderBindingConflictError)) throw conflict;
      }
    }
    const session = await this.options.sessions.issue({ contentRef, principal: input.principal });
    return {
      contentRef,
      sessionRef: session.sessionRef,
      ownerRevision: session.ownerRevision,
      source: { kind: 'workspace-file-import' as const, worktreeId: input.worktreeId, path: input.path },
    };
  }

  /** Read-only discovery of an existing owner document. Never imports, binds,
   * installs or activates anything; missing content remains missing.
   */
  async resolveExisting(input: { readonly worktreeId: string; readonly path: string }): Promise<string> {
    const contentRef = this.contentRef(input);
    await this.options.owner.load(contentRef);
    return contentRef;
  }

  private contentRef(input: { readonly worktreeId: string; readonly path: string }): string {
    if (
      !input.worktreeId ||
      !input.path ||
      input.path.includes('\\') ||
      input.path.includes('\0') ||
      input.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !/\.docx$/i.test(input.path)
    )
      throw new WorkspaceEditorUnavailableError('UNSUPPORTED_FORMAT');
    return `workspace-docx:${createHash('sha256')
      .update(JSON.stringify([this.options.ownerUserId, input.worktreeId, input.path]))
      .digest('hex')}`;
  }
}
