'use client';

import { type ReactNode, useEffect } from 'react';

/**
 * skill-issue-view — F228 frontend rendering of backend-computed skill issues.
 *
 * The backend (`/api/skills/drift-check`) is the single source of truth: it
 * returns a display-ready, de-duplicated per-skill issue list. The UI renders
 * it verbatim — no client-side scenario re-computation or cross-referencing of
 * separate endpoints.
 */

export type SkillIssueType =
  | 'conflict'
  | 'mount-missing'
  | 'unregistered'
  | 'phantom'
  | 'config-new'
  | 'config-orphan'
  | 'stale-mount';

export interface SkillIssue {
  skill: string;
  type: SkillIssueType;
  mountPoint?: string;
  message: string;
}

/** Group a flat issue list by skill name, preserving the backend's order. */
export function groupIssuesBySkill(issues: SkillIssue[]): Array<{ skill: string; messages: string[] }> {
  const map = new Map<string, string[]>();
  for (const issue of issues) {
    const list = map.get(issue.skill);
    if (list) list.push(issue.message);
    else map.set(issue.skill, [issue.message]);
  }
  return Array.from(map, ([skill, messages]) => ({ skill, messages }));
}

/** Render issues as `skill → message(s)` rows (the per-scope leaf of the tree). */
export function SkillIssueList({ issues }: { issues: SkillIssue[] }) {
  const grouped = groupIssuesBySkill(issues);
  if (grouped.length === 0) {
    return <p className="text-xs text-cafe-muted">✓ 无异常</p>;
  }
  return (
    <ul className="space-y-1.5">
      {grouped.map(({ skill, messages }) => (
        <li key={skill}>
          <p className="font-medium text-cafe">{skill}</p>
          <ul className="ml-3 mt-0.5 space-y-0.5">
            {messages.map((message) => (
              <li key={message} className="text-cafe-muted">
                {message}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Modal overlay with backdrop-click + Escape dismissal (F228 UX fix #1).
 * Clicking the dimmed backdrop or pressing Escape calls `onClose`; clicks inside
 * the panel are stopped from bubbling so they don't dismiss.
 */
export function ModalOverlay({
  onClose,
  children,
  maxWidthClass = 'max-w-xl',
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[calc(100vh-32px)] w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface-elevated p-5 shadow-xl`}
      >
        {children}
      </div>
    </div>
  );
}
