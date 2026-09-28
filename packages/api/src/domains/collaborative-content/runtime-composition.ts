import type { DormantPluginRuntimeComposition } from '../plugin/runtime-composition.js';
import { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import { readWorkspaceOfficeImport } from '../workspace/workspace-office-import.js';
import { EditorBridgeService } from './editor-bridge/service.js';
import { EditorSessionService } from './editor-session-service.js';
import { NamedCatContentService } from './named-cat-content-service.js';
import { CollaborativePatchService, type ContentPatchMaterializerPort } from './patch-service.js';
import { createPluginDocxMaterializer } from './plugin-docx-materializer.js';
import { createPluginEditorAuthority } from './plugin-editor-authority.js';
import { OfficeProviderBindingStore } from './provider-binding-store.js';
import { SemanticOperationStore } from './semantic-operation-store.js';
import { WorkspaceEditorService } from './workspace-editor-service.js';

export function createCollaborativeContentComposition(options: {
  readonly dataDir: string;
  readonly ownerUserId: string;
  readonly plugins: Pick<DormantPluginRuntimeComposition, 'inventoryStore' | 'contentEditors' | 'contentMaterializers'>;
  readonly materializer?: ContentPatchMaterializerPort;
  readonly readSource?: (worktreeId: string, path: string) => Promise<Buffer>;
}) {
  const runtime = options.plugins.contentEditors;
  if (!runtime) throw new Error('F202 content editor runtime is required');
  const owner = new ProjectContentOwnerService({ dataDir: options.dataDir });
  const bindings = new OfficeProviderBindingStore({ dataDir: options.dataDir });
  const { authority, surfaces } = createPluginEditorAuthority(runtime);
  const sessions = new EditorSessionService({ dataDir: options.dataDir, owner, bindings, authority });
  const semantic = createPluginDocxMaterializer(options.plugins.contentMaterializers);
  const patches = new CollaborativePatchService({
    owner,
    sessions,
    semanticOperations: new SemanticOperationStore(options.dataDir),
    materializer: options.materializer ?? semantic,
  });
  const bridge = new EditorBridgeService({ owner, sessions, patches });
  const workspace = new WorkspaceEditorService({
    owner,
    ownerUserId: options.ownerUserId,
    bindings,
    sessions,
    inventory: options.plugins.inventoryStore,
    runtime,
    readSource: options.readSource ?? readWorkspaceOfficeImport,
  });
  const namedCats = new NamedCatContentService({
    ownerUserId: options.ownerUserId,
    sessions,
    owner,
    patches,
    inspector: semantic,
    workspace,
  });
  return { owner, bindings, sessions, patches, bridge, surfaces, workspace, namedCats };
}
