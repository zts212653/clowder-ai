import type { CollectiveArtifactManagement } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CollectiveClientRequestError } from './client-request.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function useSharedArtifactManagement(artifact: SharedArtifact) {
  const shared = useSharedArtifacts();
  const api = shared?.api?.management;
  const fence = `${artifact.serviceInstanceId}:${artifact.collectiveId}:${artifact.artifactId}:${artifact.accessRevision}:${shared?.humanId}`;
  const current = useRef({ fence, api });
  current.current = { fence, api };
  const mounted = useRef(true);
  const matches = () => mounted.current && current.current.fence === fence && current.current.api === api;
  const generation = useRef(0);
  const reading = useRef<number>();
  const busy = useRef(false);
  const [state, setState] = useState<{
    fence: string;
    value?: CollectiveArtifactManagement;
    pending?: boolean;
    error?: string;
  }>();
  const value = state?.fence === fence ? state.value : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fence pins this exact resource and authority; identity-only catalogue polls are not a new manager session.
  const refresh = useCallback(async () => {
    if (!api || shared?.status !== 'ready') return;
    const token = ++generation.current;
    reading.current = token;
    try {
      const result = await api.read(artifact);
      if (!matches() || token !== generation.current) return;
      setState((previous) => ({
        fence,
        value: preserveManagerPages(previous?.fence === fence ? previous.value : undefined, result),
        pending: busy.current,
      }));
    } catch (error) {
      if (!matches() || token !== generation.current) return;
      const denied = error instanceof CollectiveClientRequestError && [401, 403, 404].includes(error.status);
      setState({ fence, error: denied ? '你已无法管理这件作品。' : '暂时无法核对权限与保管，请重新读取。' });
    } finally {
      if (reading.current === token) reading.current = undefined;
    }
  }, [api, fence, shared?.status]);
  useEffect(() => {
    mounted.current = true;
    busy.current = false;
    void refresh();
    const timer = window.setInterval(() => {
      if (!busy.current && reading.current === undefined) void refresh();
    }, 1800);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.clearInterval(timer);
    };
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    if (!api || busy.current) return;
    busy.current = true;
    setState({ fence, value, pending: true });
    try {
      await action();
      if (!matches()) return;
      await refresh();
      await shared?.refresh();
    } catch (error) {
      if (!matches()) return;
      await refresh();
      setState((previous) => ({
        ...previous,
        fence,
        pending: false,
        error:
          error instanceof CollectiveClientRequestError && error.status === 409
            ? '记录已变化，请核对后重新操作。'
            : '操作尚未确认，请核对并重试原操作。',
      }));
    } finally {
      if (matches()) {
        busy.current = false;
        setState((previous) => (previous?.fence === fence ? { ...previous, pending: false } : previous));
      }
    }
  };
  const more = async () => {
    if (!api || !value || value.nextOffset === undefined || busy.current) return;
    busy.current = true;
    setState({ fence, value, pending: true });
    const token = ++generation.current;
    try {
      const next = await api.read(artifact, { offset: value.nextOffset, snapshot: value.snapshot });
      if (!matches() || token !== generation.current) return;
      setState({ fence, value: appendManagerPage(value, next) });
    } catch {
      if (matches()) await refresh();
    } finally {
      if (matches()) {
        busy.current = false;
        setState((previous) => (previous?.fence === fence ? { ...previous, pending: false } : previous));
      }
    }
  };
  return {
    api,
    value,
    run,
    more,
    refresh,
    pending: state?.fence === fence && Boolean(state.pending),
    error: state?.fence === fence ? state.error : undefined,
    unconfirmed: Boolean(api?.hasPending(artifact)),
  };
}

function preserveManagerPages(previous: CollectiveArtifactManagement | undefined, next: CollectiveArtifactManagement) {
  return previous?.snapshot === next.snapshot && previous.members.length > next.members.length ? previous : next;
}

function appendManagerPage(previous: CollectiveArtifactManagement, next: CollectiveArtifactManagement) {
  const members = [...previous.members, ...next.members];
  if (
    next.snapshot !== previous.snapshot ||
    next.offset !== previous.nextOffset ||
    next.total !== previous.total ||
    new Set(members.map((member) => member.humanId)).size !== members.length
  )
    throw new Error('Management page changed');
  return { ...next, offset: 0, members };
}
