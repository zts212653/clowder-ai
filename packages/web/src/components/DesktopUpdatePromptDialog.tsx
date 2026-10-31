import type { RefObject } from 'react';
import { DesktopUpdatePromptContent } from './DesktopUpdatePromptContent';

interface DesktopUpdatePromptDialogProps {
  prompt: DesktopUpdatePromptPayload;
  dialogRef: RefObject<HTMLElement>;
  sendAction: (action: DesktopUpdatePromptAction) => void;
}

export function DesktopUpdatePromptDialog({ prompt, dialogRef, sendAction }: DesktopUpdatePromptDialogProps) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
        tabIndex={-1}
        className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-2xl ${
          prompt.kind === 'available' ? 'max-w-2xl' : 'max-w-lg'
        }`}
      >
        <DesktopUpdatePromptContent prompt={prompt} sendAction={sendAction} />
      </section>
    </div>
  );
}
