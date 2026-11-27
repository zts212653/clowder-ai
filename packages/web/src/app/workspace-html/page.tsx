import '../globals.css';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { WorkspaceHtmlPreview } from '@/components/workbench/WorkspaceHtmlPreview';

export default async function WorkspaceHtmlPage({
  searchParams,
}: {
  searchParams: Promise<{ worktreeId?: string; path?: string }>;
}) {
  const { worktreeId, path } = await searchParams;
  if (typeof worktreeId !== 'string' || !worktreeId || typeof path !== 'string' || !/\.html?$/i.test(path)) return null;
  return (
    <>
      <SessionBootstrap />
      <main className="flex h-screen min-h-0 flex-col">
        <WorkspaceHtmlPreview worktreeId={worktreeId} path={path} />
      </main>
    </>
  );
}
