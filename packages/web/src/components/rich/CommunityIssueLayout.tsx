'use client';

import { type ReactNode, useId } from 'react';

export const communityPrimaryAction =
  'rounded-md bg-[var(--evolution-focus-text)] px-3 py-2 text-xs font-medium text-[var(--cafe-accent-foreground)] transition hover:bg-cafe-accent-hover disabled:opacity-50';

export function CommunityIssueSurface({ children }: { children: ReactNode }) {
  return (
    <section
      data-testid="community-issue-card"
      className="w-[42rem] max-w-full min-w-0 space-y-3 rounded-lg border border-cafe-subtle bg-cafe-surface p-3 text-sm text-cafe-text"
    >
      {children}
    </section>
  );
}

export function CommunityIssueReport({ title, bodyMarkdown }: { title: string; bodyMarkdown: string }) {
  return (
    <section aria-label="公开报告" className="min-w-0 space-y-2 break-words">
      <h3 className="font-medium">{title}</h3>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{bodyMarkdown}</div>
    </section>
  );
}

export function CommunityIssueEditor({
  title,
  bodyMarkdown,
  onTitleChange,
  onBodyChange,
  disabled = false,
}: {
  title: string;
  bodyMarkdown: string;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-3">
      <label htmlFor={`${id}-title`} className="block text-xs text-cafe-muted">
        标题
        <input
          id={`${id}-title`}
          aria-label="报告标题"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          disabled={disabled}
          className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm text-cafe focus:outline-2 focus:outline-offset-2 focus:outline-[var(--evolution-focus)] disabled:opacity-60"
        />
      </label>
      <label htmlFor={`${id}-body`} className="block text-xs text-cafe-muted">
        公开报告（Markdown）
        <textarea
          id={`${id}-body`}
          aria-label="公开报告"
          rows={7}
          value={bodyMarkdown}
          onChange={(event) => onBodyChange(event.target.value)}
          disabled={disabled}
          className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm leading-relaxed text-cafe focus:outline-2 focus:outline-offset-2 focus:outline-[var(--evolution-focus)] disabled:opacity-60"
        />
      </label>
    </div>
  );
}
