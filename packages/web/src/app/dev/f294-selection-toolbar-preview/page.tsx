'use client';

import { MessageSelectionToolbar } from '@/components/MessageSelectionToolbar';

export default function F294SelectionToolbarPreviewPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-cafe-surface" data-testid="f294-selection-toolbar-preview">
      <div className="flex min-h-screen w-full flex-col" data-testid="chat-canvas">
        <div className="flex-1" />
        <MessageSelectionToolbar
          threadId="f294-layout-preview"
          selectedMessageIds={['message-1', 'message-2']}
          onCancel={() => {}}
          onExportSuccess={() => {}}
          onForward={() => {}}
        />
      </div>
    </main>
  );
}
