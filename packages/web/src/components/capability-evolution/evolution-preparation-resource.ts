'use client';

import { type EvolutionPreparationReviewV1, evolutionPreparationReviewV1Schema, refIdentity } from '@cat-cafe/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';
import type { EvolutionProgramProjection } from './evolution-program-projection';

const READ_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 30_000;

interface PreparationReadState {
  key: string;
  review?: EvolutionPreparationReviewV1;
  error?: string;
  loading: boolean;
}
interface PreparationReadSession {
  active: boolean;
  generation: number;
  inFlight?: { controller: AbortController; generation: number };
}

function publicationTime(review: EvolutionPreparationReviewV1 | undefined): number | undefined {
  if (review?.status !== 'resolved' && review?.status !== 'unpublished') return undefined;
  return Date.parse(review.updatedAt);
}

async function parseReviewResponse(response: Response, projection: EvolutionProgramProjection) {
  if ([401, 403, 404].includes(response.status)) throw new Error('preparation read is not authorized');
  const parsed = evolutionPreparationReviewV1Schema.safeParse(await response.json());
  if (!parsed.success || (!response.ok && response.status !== 422 && response.status !== 503))
    throw new Error('invalid preparation response');
  const review = parsed.data;
  if (
    review.programRef.ownerFeatureId !== 'F311' ||
    review.programRef.ownerStateRef !== projection.program.programId ||
    refIdentity(review.objectRef) !== refIdentity(projection.program.objectRef)
  )
    throw new Error('preparation response identity mismatch');
  return review;
}

function acceptNewerReview(
  previous: PreparationReadState,
  key: string,
  incoming: EvolutionPreparationReviewV1,
): PreparationReadState {
  if (previous.key !== key) return previous;
  const before = publicationTime(previous.review);
  const next = publicationTime(incoming);
  return before !== undefined && next !== undefined && next < before
    ? { ...previous, loading: false, error: undefined }
    : { key, review: incoming, loading: false };
}

function currentRequest(session: PreparationReadSession, generation: number): boolean {
  return session.active && generation === session.generation;
}

function failRead(
  session: PreparationReadSession,
  generation: number,
  key: string,
  setState: Dispatch<SetStateAction<PreparationReadState>>,
) {
  if (currentRequest(session, generation)) setState({ key, loading: false, error: '准备材料暂时无法读取。' });
}

function expireRead(
  session: PreparationReadSession,
  generation: number,
  key: string,
  setState: Dispatch<SetStateAction<PreparationReadState>>,
) {
  if (!currentRequest(session, generation) || session.inFlight?.generation !== generation) return;
  session.generation += 1;
  session.inFlight.controller.abort();
  session.inFlight = undefined;
  setState({ key, loading: false, error: '准备材料暂时无法读取。' });
}

export function useEvolutionPreparationReview(projection: EvolutionProgramProjection) {
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const key = JSON.stringify([
    projection.program.workspaceId,
    projection.program.programId,
    refIdentity(projection.program.objectRef),
  ]);
  const [state, setState] = useState<PreparationReadState>({ key, loading: true });
  const requestTarget = useRef(projection);
  const retryRead = useRef<() => void>(() => undefined);
  const retry = useCallback(() => retryRead.current(), []);
  requestTarget.current = projection;

  useEffect(() => {
    if (!surfaceVisible) {
      retryRead.current = () => undefined;
      return;
    }
    const target = requestTarget.current;
    const session: PreparationReadSession = { active: true, generation: 0 };
    setState((current) => (current.key === key ? current : { key, loading: true }));

    const read = async () => {
      if (session.inFlight) return;
      const generation = ++session.generation;
      const controller = new AbortController();
      session.inFlight = { controller, generation };
      const timeout = window.setTimeout(() => expireRead(session, generation, key, setState), READ_TIMEOUT_MS);
      try {
        const response = await apiFetch(
          `/api/capability-evolution/programs/${encodeURIComponent(target.program.programId)}/preparation-review`,
          { signal: controller.signal },
        );
        if (!currentRequest(session, generation)) return;
        const incoming = await parseReviewResponse(response, target);
        setState((previous) => acceptNewerReview(previous, key, incoming));
      } catch {
        failRead(session, generation, key, setState);
      } finally {
        window.clearTimeout(timeout);
        if (session.inFlight?.generation === generation) session.inFlight = undefined;
      }
    };

    const refresh = () => {
      if (document.visibilityState === 'visible') void read();
    };
    retryRead.current = () => {
      if (!session.active) return;
      setState({ key, loading: true });
      void read();
    };
    void read();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      session.active = false;
      session.generation += 1;
      session.inFlight?.controller.abort();
      session.inFlight = undefined;
      retryRead.current = () => undefined;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, surfaceVisible]);

  return {
    review: state.key === key ? state.review : undefined,
    error: state.key === key ? state.error : undefined,
    loading: state.key !== key || state.loading,
    retry,
  };
}
