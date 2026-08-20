import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

type AvailablePrompt = Extract<DesktopUpdatePromptPayload, { kind: 'available' }>;
type ReadyPrompt = Extract<DesktopUpdatePromptPayload, { kind: 'ready-to-install' }>;
type UpToDatePrompt = Extract<DesktopUpdatePromptPayload, { kind: 'up-to-date' }>;
type CheckFailedPrompt = Extract<DesktopUpdatePromptPayload, { kind: 'check-failed' }>;
type SendAction = (action: DesktopUpdatePromptAction) => void;

function ReleaseNotes({ content }: { content: string }) {
  return (
    <div className="text-sm text-cafe-secondary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h1: ({ children }) => <h4 className="mb-2 text-base font-bold text-cafe-primary">{children}</h4>,
          h2: ({ children }) => (
            <h4 className="mb-2 mt-3 text-sm font-bold text-cafe-primary first:mt-0">{children}</h4>
          ),
          h3: ({ children }) => (
            <h4 className="mb-1 mt-2 text-sm font-semibold text-cafe-primary first:mt-0">{children}</h4>
          ),
          p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-conn-blue-text hover:underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-cafe-accent/40 pl-3 opacity-80">{children}</blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-cafe-surface-elevated px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-cafe-surface-elevated p-3">{children}</pre>
          ),
          img: ({ alt }) => (
            <span className="block rounded-lg border border-cafe px-3 py-2 text-xs text-cafe-muted">
              Release image omitted{alt ? `: ${alt}` : ''}. Open the complete release page to view it.
            </span>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-cafe bg-cafe-surface-elevated px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-cafe px-2 py-1">{children}</td>,
          hr: () => <hr className="my-3 border-cafe" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function AvailableContent({ prompt, sendAction }: { prompt: AvailablePrompt; sendAction: SendAction }) {
  return (
    <>
      <header className="border-b border-cafe px-6 py-5">
        <p
          data-testid="desktop-update-eyebrow"
          className="mb-1 text-xs font-semibold uppercase tracking-wider text-cafe-accent"
        >
          Update Available
        </p>
        <h2 id="desktop-update-title" className="text-xl font-semibold text-cafe-primary">
          Clowder AI{' '}
          <a
            data-testid="desktop-update-release-link"
            href={prompt.releaseUrl}
            onClick={(event) => {
              event.preventDefault();
              sendAction('open-release');
            }}
            className="console-inline-link underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
          >
            v{prompt.version}
          </a>{' '}
          is available
        </h2>
        <p className="mt-2 text-sm text-cafe-secondary">Current version: v{prompt.currentVersion}</p>
      </header>

      <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
        <div
          data-testid="desktop-update-recommendation"
          className="rounded-xl border border-cafe-accent/30 bg-cafe-accent/10 px-4 py-4"
        >
          <p className="text-sm font-semibold text-cafe-primary">
            Recommended for {prompt.platform === 'windows' ? 'Windows' : 'macOS'}
          </p>
          <code className="mt-2 block break-all text-sm text-cafe-accent">{prompt.assetName}</code>
          <p className="mt-2 text-sm text-cafe-secondary">
            This is the package selected for your current system. The download is verified before installation.
          </p>
        </div>
        <section aria-labelledby="desktop-update-release-notes-title">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 id="desktop-update-release-notes-title" className="text-sm font-semibold text-cafe-primary">
              Release notes
            </h3>
            <span className="text-xs text-cafe-muted">v{prompt.version}</span>
          </div>
          <div
            data-testid="desktop-update-release-notes"
            className="max-h-64 overflow-y-auto rounded-xl border border-cafe bg-cafe-surface-sunken px-4 py-3 text-cafe-secondary"
          >
            {prompt.releaseNotes ? (
              <ReleaseNotes content={prompt.releaseNotes} />
            ) : (
              <p className="text-sm">No release notes were provided for this version.</p>
            )}
          </div>
          <p className="mt-2 text-xs text-cafe-muted">Select the version above to open the complete release page.</p>
        </section>
      </div>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-cafe bg-cafe-surface-elevated px-6 py-4">
        <button
          type="button"
          onClick={() => sendAction('skip')}
          className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
        >
          Skip This Version
        </button>
        <button
          type="button"
          onClick={() => sendAction('later')}
          className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
        >
          Later
        </button>
        <button
          type="button"
          onClick={() => sendAction('download')}
          className="console-button-primary px-5 py-2 text-sm"
        >
          {prompt.platform === 'windows' ? 'Download Windows Setup' : 'Download macOS DMG'}
        </button>
      </footer>
    </>
  );
}

function ReadyContent({ prompt, sendAction }: { prompt: ReadyPrompt; sendAction: SendAction }) {
  return (
    <>
      <header className="border-b border-cafe px-6 py-5">
        <p
          data-testid="desktop-update-eyebrow"
          className="mb-1 text-xs font-semibold uppercase tracking-wider text-cafe-accent"
        >
          Ready to install
        </p>
        <h2 id="desktop-update-title" className="text-xl font-semibold text-cafe-primary">
          Clowder AI v{prompt.version} is ready
        </h2>
      </header>

      <div className="min-h-0 overflow-y-auto px-6 py-5">
        <div className="rounded-xl border border-cafe-accent/30 bg-cafe-accent/10 px-4 py-4">
          <p className="text-sm font-semibold text-cafe-primary">Verified update package</p>
          <code className="mt-2 block break-all text-sm text-cafe-accent">{prompt.assetName}</code>
          <p className="mt-3 text-sm text-cafe-secondary">
            {prompt.platform === 'windows'
              ? 'The app will close and the installer will run. Your data will be preserved.'
              : 'Clowder AI will quit and open the verified DMG. Drag it into Applications to replace the old version; your data will not be affected.'}
          </p>
        </div>
      </div>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-cafe bg-cafe-surface-elevated px-6 py-4">
        <button
          type="button"
          onClick={() => sendAction('later')}
          className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
        >
          Later
        </button>
        <button
          type="button"
          onClick={() => sendAction('install')}
          className="console-button-primary px-5 py-2 text-sm"
        >
          {prompt.platform === 'windows' ? 'Restart & Upgrade' : 'Quit & Install'}
        </button>
      </footer>
    </>
  );
}

function UpToDateContent({ prompt, sendAction }: { prompt: UpToDatePrompt; sendAction: SendAction }) {
  return (
    <>
      <header className="border-b border-cafe px-6 py-5">
        <p
          data-testid="desktop-update-eyebrow"
          className="mb-1 text-xs font-semibold uppercase tracking-wider text-cafe-accent"
        >
          You&apos;re up to date
        </p>
        <h2 id="desktop-update-title" className="text-xl font-semibold text-cafe-primary">
          Clowder AI v{prompt.version}
        </h2>
      </header>
      <div className="px-6 py-5">
        <p className="text-sm text-cafe-secondary">
          No update is required. You&apos;re running the latest available version.
        </p>
      </div>
      <footer className="flex justify-end border-t border-cafe bg-cafe-surface-elevated px-6 py-4">
        <button
          type="button"
          onClick={() => sendAction('dismiss')}
          className="console-button-primary px-5 py-2 text-sm"
        >
          OK
        </button>
      </footer>
    </>
  );
}

function CheckFailedContent({ prompt, sendAction }: { prompt: CheckFailedPrompt; sendAction: SendAction }) {
  return (
    <>
      <header className="border-b border-cafe px-6 py-5">
        <p
          data-testid="desktop-update-eyebrow"
          className="mb-1 text-xs font-semibold uppercase tracking-wider text-cafe-accent"
        >
          Update check failed
        </p>
        <h2 id="desktop-update-title" className="text-xl font-semibold text-cafe-primary">
          Couldn&apos;t check for updates
        </h2>
      </header>
      <div className="px-6 py-5">
        <p className="text-sm text-cafe-secondary">
          We couldn&apos;t reach the release service. You can view the latest releases on GitHub.
        </p>
        <p className="mt-2 text-xs text-cafe-muted">Current version: v{prompt.version}</p>
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-cafe bg-cafe-surface-elevated px-6 py-4">
        <button
          type="button"
          onClick={() => sendAction('open-release')}
          className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
        >
          View Releases
        </button>
        <button
          type="button"
          onClick={() => sendAction('dismiss')}
          className="console-button-primary px-5 py-2 text-sm"
        >
          OK
        </button>
      </footer>
    </>
  );
}

export function DesktopUpdatePromptContent({
  prompt,
  sendAction,
}: {
  prompt: DesktopUpdatePromptPayload;
  sendAction: SendAction;
}) {
  switch (prompt.kind) {
    case 'available':
      return <AvailableContent prompt={prompt} sendAction={sendAction} />;
    case 'ready-to-install':
      return <ReadyContent prompt={prompt} sendAction={sendAction} />;
    case 'up-to-date':
      return <UpToDateContent prompt={prompt} sendAction={sendAction} />;
    case 'check-failed':
      return <CheckFailedContent prompt={prompt} sendAction={sendAction} />;
  }
}
