'use client';
import type { MessagePublicationChoice, MessagePublicationLanding, PublicationReviewContext } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { checked, json } from '@/components/content-review/modification-http';
import { apiFetch } from '@/utils/api-client';
import { continueReviewLabel, publicationContextCatalogueSchema } from './publication-context';

export interface NamedChoice {
  readonly choice: MessagePublicationChoice;
  readonly heading: string;
  readonly detail: string;
}

const choiceKey = (choice: MessagePublicationChoice) => `${choice.asset.contentRef}:${choice.asset.ownerRevision}`;
const workNoun = (choice: MessagePublicationChoice | undefined) =>
  choice?.asset.mediaType === 'video/mp4' ? '这段视频' : '这张图';

/**
 * F309 parent decision 102: each copy of the image is named by what the user continues — the image
 * itself, or the review a cat asked them to judge. A pending judgment comes first. A Task copy whose
 * review cannot be read keeps its task name; that is not a claim that no review exists.
 */
export function namedChoices(
  choices: readonly MessagePublicationChoice[],
  reviews: Readonly<Record<string, PublicationReviewContext | null>>,
): NamedChoice[] {
  const pending = (choice: MessagePublicationChoice) =>
    Boolean(choice.taskTitle) && reviews[choiceKey(choice)]?.state === 'awaiting_human';
  return [...choices.filter(pending), ...choices.filter((choice) => !pending(choice))].map((choice) => {
    const version = `第 ${choice.asset.ownerRevision} 版`;
    if (!choice.taskTitle)
      return {
        choice,
        heading: `直接在${workNoun(choice)}上讨论（独立于任务审阅）`,
        detail: `${version} · ${choice.threadTitle}`,
      };
    const review = reviews[choiceKey(choice)];
    const cat = choice.targetName ?? '原负责猫';
    return {
      choice,
      heading: review ? continueReviewLabel(review) : `继续${cat}的任务：${choice.taskTitle}`,
      detail: `任务：${choice.taskTitle} · ${version} · ${choice.threadTitle}`,
    };
  });
}

export function choiceIntro(choices: readonly MessagePublicationChoice[]): string {
  return choices.some((choice) => choice.taskTitle)
    ? `${workNoun(choices[0])}已关联猫的任务审阅。请选择要继续的讨论；各处的标注和回复分开保存。`
    : '这条发布记录关联了已有作品。请选择要继续的原作品；原讨论会保留在各自的版本中。';
}

/** Reads the review each Task copy carries, through the same authorized resolve the landing uses. */
export function useChoiceReviews(landing: MessagePublicationLanding | null) {
  const choices = landing?.status === 'choice-required' ? landing.choices : undefined;
  const [reviews, setReviews] = useState<Record<string, PublicationReviewContext | null>>({});
  const latest = useRef(choices);
  latest.current = choices;
  const signature = (choices ?? [])
    .filter((choice) => choice.taskTitle)
    .map(choiceKey)
    .join('|');
  useEffect(() => {
    if (!signature) return;
    const taskChoices = (latest.current ?? []).filter((choice) => choice.taskTitle);
    const abort = new AbortController();
    void Promise.all(
      taskChoices.map(async (choice) => {
        try {
          const catalogue = publicationContextCatalogueSchema.parse(
            await checked<unknown>(
              await apiFetch('/api/content-reviews/resolve', {
                ...json({ contentRef: choice.asset.contentRef, ownerRevision: choice.asset.ownerRevision }),
                signal: abort.signal,
              }),
            ),
          );
          const review =
            catalogue.contexts.find((context) => context.state === 'awaiting_human') ?? catalogue.contexts[0] ?? null;
          return [choiceKey(choice), review] as const;
        } catch {
          return [choiceKey(choice), null] as const;
        }
      }),
    ).then((pairs) => {
      if (!abort.signal.aborted) setReviews(Object.fromEntries(pairs));
    });
    return () => abort.abort();
  }, [signature]);
  return reviews;
}
