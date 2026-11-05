import { MarkdownSurface } from '@cat-cafe/ui';
import { profileSections } from './profile-presentation';

/** Reading projection only: edits always retain the original Markdown and metadata. */
export function MemoryProfileBody({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-3' : 'grid min-w-0 gap-3 xl:grid-cols-2'}>
      {profileSections(content).map((section, index) => (
        <section
          key={`${index}:${section.title}`}
          className={
            compact ? 'min-w-0 space-y-2' : 'min-w-0 space-y-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-4'
          }
        >
          {section.title && <h4 className="text-sm font-medium">{section.title}</h4>}
          <div className="break-words text-sm leading-relaxed [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:bg-cafe-surface-sunken [&_code]:px-1 [&_a]:text-cafe-accent [&_a]:underline [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
            <MarkdownSurface
              components={{
                img: ({ alt }) => <span>{alt}</span>,
                a: ({ children, ...props }) => (
                  <a {...props} rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {section.body}
            </MarkdownSurface>
          </div>
        </section>
      ))}
    </div>
  );
}
