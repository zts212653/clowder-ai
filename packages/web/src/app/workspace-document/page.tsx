import '../globals.css';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { WorkspaceOfficeSurface } from '@/components/workbench/content-editor/WorkspaceOfficeSurface';
import { WorkspacePluginFilePreview } from '@/components/workbench/WorkspacePluginFilePreview';

export default async function WorkspaceDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ worktreeId?: string; path?: string }>;
}) {
  const { worktreeId, path } = await searchParams;
  if (typeof worktreeId !== 'string' || !worktreeId || typeof path !== 'string' || !path) return null;
  const target = { worktreeId, path };
  return (
    <>
      <SessionBootstrap />
      <main className="flex h-screen min-h-0 flex-col">
        {/\.docx$/i.test(path) ? (
          <WorkspaceOfficeSurface worktreeId={worktreeId} path={path} />
        ) : (
          <WorkspacePluginFilePreview
            target={target}
            showPluginSettings={/\.(pdf|pptx)$/i.test(path)}
            fallback={<p className="p-4 text-sm text-cafe-muted">暂无文件预览。</p>}
          />
        )}
      </main>
    </>
  );
}
