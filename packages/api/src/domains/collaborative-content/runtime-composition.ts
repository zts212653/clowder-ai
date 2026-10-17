import type { DormantPluginRuntimeComposition } from '../plugin/runtime-composition.js';
import { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import type { AuthorizeVideoProjectCat } from '../video-studio/project/access.js';
import { VideoProjectAssetIndex } from '../video-studio/project/asset-index.js';
import { VideoProjectScreeningService } from '../video-studio/project/screening-service.js';
import type { AuthorizeScreeningCatSource } from '../video-studio/project/screening-types.js';
import {
  type AuthorizeVideoProjectSelfReviewSource,
  VideoProjectSelfReviewService,
} from '../video-studio/project/self-review.js';
import { VideoProjectService } from '../video-studio/project/service.js';
import {
  createWorkspaceContentSource,
  resolveWorkspaceContentRoot,
} from '../workspace/workspace-content-source-factory.js';
import { readWorkspaceOfficeImport } from '../workspace/workspace-office-import.js';
import { EditorBridgeService } from './editor-bridge/service.js';
import { EditorSessionService } from './editor-session-service.js';
import { type ContentInspectionPort, NamedCatContentService } from './named-cat-content-service.js';
import { CollaborativePatchService, type ContentPatchMaterializerPort } from './patch-service.js';
import { createPluginEditorAuthority } from './plugin-editor-authority.js';
import { createPluginEditorWorker } from './plugin-editor-worker.js';
import { OfficeProviderBindingStore } from './provider-binding-store.js';
import { SemanticOperationStore } from './semantic-operation-store.js';
import { WorkspaceEditorService } from './workspace-editor-service.js';

export function createCollaborativeContentComposition(options: {
  readonly dataDir: string;
  readonly ownerUserId: string;
  readonly plugins: Pick<DormantPluginRuntimeComposition, 'inventoryStore' | 'contentEditors' | 'editorWorkers'>;
  readonly materializer?: ContentPatchMaterializerPort;
  readonly inspector?: ContentInspectionPort;
  readonly readSource?: (worktreeId: string, path: string) => Promise<Buffer>;
  /** Trusted invocation/delegation port; omission deliberately denies Cat project access. */
  readonly authorizeVideoProjectCat?: AuthorizeVideoProjectCat;
  /** Separate original-Human-source admission; a generic project grant cannot mint publication authority. */
  readonly authorizeScreeningCatSource?: AuthorizeScreeningCatSource;
  readonly authorizeVideoProjectSelfReviewSource?: AuthorizeVideoProjectSelfReviewSource;
}) {
  const runtime = options.plugins.contentEditors;
  if (!runtime) throw new Error('F202 content editor runtime is required');
  const owner = new ProjectContentOwnerService({ dataDir: options.dataDir });
  const projects = new VideoProjectService({
    owner,
    ownerUserId: options.ownerUserId,
    assets: new VideoProjectAssetIndex({ resolveRoot: resolveWorkspaceContentRoot }),
    ...(options.authorizeVideoProjectCat ? { authorizeCat: options.authorizeVideoProjectCat } : {}),
  });
  const projectMediaSource = createWorkspaceContentSource(options.ownerUserId);
  const screenings = new VideoProjectScreeningService({
    owner,
    projects,
    workspace: projectMediaSource,
    appendScreening: (input) => projects.appendScreening(input),
    ...(options.authorizeScreeningCatSource ? { authorizeCatSource: options.authorizeScreeningCatSource } : {}),
  });
  const selfReviews = new VideoProjectSelfReviewService({
    projects,
    appendSelfReview: (input) => projects.appendSelfReview(input),
    ...(options.authorizeVideoProjectSelfReviewSource
      ? { authorizeSource: options.authorizeVideoProjectSelfReviewSource }
      : {}),
  });
  const bindings = new OfficeProviderBindingStore({ dataDir: options.dataDir });
  const { authority, surfaces } = createPluginEditorAuthority(runtime);
  const sessions = new EditorSessionService({ dataDir: options.dataDir, owner, bindings, authority });
  const semantic = createPluginEditorWorker(options.plugins.editorWorkers);
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
    inspector: options.inspector ?? semantic,
    workspace,
  });
  return {
    owner,
    projects,
    screenings,
    selfReviews,
    projectMediaSource,
    bindings,
    sessions,
    patches,
    bridge,
    surfaces,
    workspace,
    namedCats,
  };
}
