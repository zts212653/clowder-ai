import { z } from 'zod';
import type { Thread } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { HomeActionTarget } from '../../../action/HomeActionController.js';
import { sha256 } from '../page-action/live-page-action-authority-contract.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const homeHubStateSchema = z
  .object({
    clientId: z.string().uuid(),
    clientToken: z.string().uuid(),
    route: z
      .string()
      .max(512)
      .regex(/^\/[^\r\n#]*$/),
    threadId: id.nullable(),
    composer: z.boolean(),
    sections: z.array(z.object({ id, label: z.string().min(1).max(128) }).strict()).max(16),
  })
  .strict();
export type HomeHubState = z.infer<typeof homeHubStateSchema>;
export type HomeOwnedTarget = HomeActionTarget & {
  pageId: string;
  clientId: string;
  clientToken: string;
  route: string;
  ownerAction:
    | { kind: 'thread'; threadId: string }
    | { kind: 'settings'; sectionId: string }
    | { kind: 'draft'; threadId: string };
};

function lexicalScore(title: string, request: string): number {
  const normalized = title.toLocaleLowerCase();
  const query = request.toLocaleLowerCase();
  if (normalized && query.includes(normalized)) return normalized.length * 10;
  const grams = new Set(
    Array.from(normalized)
      .slice(0, -1)
      .map((char, i) => char + normalized[i + 1]),
  );
  return [...grams].filter((gram) => query.includes(gram)).length;
}

/** Retrieval ranks owner-visible conversation metadata; Jev, rather than this adapter, chooses the action. */
export function homeHubTargets(state: HomeHubState, visible: readonly Thread[], request: string): HomeOwnedTarget[] {
  const targets: HomeOwnedTarget[] = [];
  const add = (
    label: string,
    ownerAction: HomeOwnedTarget['ownerAction'],
    operation: HomeActionTarget['operation'],
  ) => {
    const revision = sha256(JSON.stringify([state, ownerAction, label]));
    targets.push({
      id: `home-${revision.slice(0, 32)}`,
      label,
      operation,
      revision,
      pageId: `home-page-${sha256(JSON.stringify(state))}`,
      clientId: state.clientId,
      clientToken: state.clientToken,
      route: state.route,
      ownerAction,
    });
  };
  for (const section of state.sections)
    add(`打开设置：${section.label}`, { kind: 'settings', sectionId: section.id }, 'click');
  if (state.composer && state.threadId && visible.some((thread) => thread.id === state.threadId && !thread.deletedAt))
    add('在当前对话输入框追加原文，保留草稿与附件，不发送', { kind: 'draft', threadId: state.threadId }, 'fill');
  const threads = visible
    .filter((thread) => !thread.deletedAt && thread.title?.trim())
    .sort(
      (a, b) =>
        lexicalScore(b.title ?? '', request) - lexicalScore(a.title ?? '', request) || b.lastActiveAt - a.lastActiveAt,
    );
  for (const thread of threads.slice(0, 32 - targets.length))
    add(`打开对话：${thread.title?.slice(0, 490)}`, { kind: 'thread', threadId: thread.id }, 'click');
  return targets;
}

/** Additional literal assignment syntax is scoped to the home composer, not configured page values. */
export function homeComposerLiteralValues(text: string): readonly string[] {
  const match =
    /^(?:请|帮我)?(?:在|往)(?:当前|这个|对话的)?(?:输入框|草稿)(?:里|中)?(?:写入|写|放入|放|追加)(?:一句|这句话)?[：:]([\s\S]{1,2000})$/u.exec(
      text.trim(),
    );
  return match?.[1]?.trim() ? [match[1].trim()] : [];
}
