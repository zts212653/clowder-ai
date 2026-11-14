import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatFileReferenceView } from '../../../src/components/chat-references/ChatFileReferenceView';
import { FileActions } from '../../../src/components/content-review/FileActions';
import { writeShellLanguage } from '../../../src/components/shell/shell-language';

writeShellLanguage(new URLSearchParams(window.location.search).get('language') === 'zh' ? 'zh' : 'en');
const absolutePath = `C:\\demo\\${'long directory with spaces\\'.repeat(4)}${'a'.repeat(180)}\\report.md`;
function Surface() {
  const anchor = useRef<HTMLSpanElement>(null);
  if (new URLSearchParams(window.location.search).has('classic'))
    return (
      <section aria-label="Classic file toolbar">
        <FileActions
          source={{ kind: 'workspace', worktreeId: 'fixture', path: 'docs/report.md' }}
          filename="report.md"
          appearance="classic"
        />
      </section>
    );
  return (
    <main>
      <ChatFileReferenceView
        target={{
          kind: 'file',
          entryType: 'file',
          worktreeId: 'fixture',
          path: 'docs/report.md',
          absolutePath,
          line: null,
          mime: 'text/markdown',
          size: 42,
          modifiedAt: '2026-11-03T00:00:00Z',
        }}
        layout="card"
        anchor={anchor}
        onOpen={() => {}}
        error=""
        lightbox={null}
      />
      <section aria-label="Uploaded document">
        <FileActions source={{ kind: 'url', url: '/api/uploads/report.md' }} filename="report.md" />
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
