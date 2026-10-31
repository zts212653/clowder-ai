'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountSelection, AccountsResponse, ProfileItem } from '../hub-accounts.types';

export function useAccountDirectory() {
  const [data, setData] = useState<AccountsResponse>();
  const [claudeSelection, setClaudeSelection] = useState<AccountSelection>();
  const [claudeMemberError, setClaudeMemberError] = useState('');
  const claudeSequence = useRef(0);
  const [selection, setSelection] = useState<AccountSelection>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [memberError, setMemberError] = useState('');
  const generation = useRef(0);
  const membersSequence = useRef(0);
  const refresh = useCallback(async () => {
    const observed = ++generation.current;
    const membersRead = ++membersSequence.current;
    const fetchMembers = async () => {
      try {
        const response = await apiFetch('/api/accounts/codex/members', undefined, { afterCurrentGet: true });
        if (!response.ok) throw new Error('成员使用的账号读不到');
        const body = (await response.json()) as { selection?: AccountSelection };
        if (membersRead !== membersSequence.current) return;
        setSelection(body.selection);
        setMemberError(body.selection ? '' : '成员使用的账号读不到');
      } catch {
        if (membersRead === membersSequence.current) {
          setSelection(undefined);
          setMemberError('成员使用的账号读不到');
        }
      }
    };
    void fetchMembers();
    const claudeRead = ++claudeSequence.current;
    void apiFetch('/api/accounts/claude/members', undefined, { afterCurrentGet: true })
      .then(async (response) => {
        if (!response.ok) throw new Error('selection_unavailable');
        const body = (await response.json()) as { selection?: AccountSelection };
        if (claudeRead !== claudeSequence.current) return;
        setClaudeSelection(body.selection);
        setClaudeMemberError(body.selection ? '' : 'selection_unavailable');
      })
      .catch(() => {
        if (claudeRead !== claudeSequence.current) return;
        setClaudeSelection(undefined);
        setClaudeMemberError('selection_unavailable');
      });
    try {
      const response = await apiFetch('/api/accounts', undefined, { afterCurrentGet: true });
      const body = (await response.json()) as AccountsResponse & { error?: string };
      if (observed !== generation.current) return;
      if (!response.ok) throw new Error(body.error ?? '账号列表加载失败');
      setData(body);
      setError('');
    } catch (e) {
      if (observed === generation.current) setError(e instanceof Error ? e.message : '账号列表加载失败');
    } finally {
      if (observed === generation.current) setLoading(false);
    }
  }, []);
  const update = useCallback((profiles: ProfileItem[], removed: string[] = []) => {
    generation.current++;
    setData((current) =>
      current
        ? {
            ...current,
            providers: [
              ...current.providers.filter((p) => !removed.includes(p.id) && !profiles.some((next) => next.id === p.id)),
              ...profiles,
            ],
          }
        : { projectPath: '', providers: profiles },
    );
    setError('');
    setLoading(false);
  }, []);
  const applyBinding = useCallback((next: AccountSelection, client = 'openai') => {
    if (client === 'anthropic') {
      claudeSequence.current++;
      setClaudeSelection(next);
      setClaudeMemberError('');
      return;
    }
    membersSequence.current++;
    setSelection(next);
    setMemberError('');
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const waiting = data?.providers.some((p) =>
    ['preparing', 'queued', 'waiting'].includes(p.codex?.attempt?.state ?? ''),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  const renewalPending = data?.providers.some(
    (p) =>
      p.quota?.status === 'unavailable' &&
      (p.quota.failure?.kind === 'renewal_required' || /登录凭据已过期/.test(p.quota.error ?? '')),
  );
  useEffect(() => {
    if (!renewalPending) return;
    const check = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = setInterval(check, 15000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [renewalPending, refresh]);
  useEffect(() => {
    const reconcile = () => {
      void refresh();
    };
    window.addEventListener('accounts-changed', reconcile);
    window.addEventListener('cat-config-changed', reconcile);
    return () => {
      window.removeEventListener('accounts-changed', reconcile);
      window.removeEventListener('cat-config-changed', reconcile);
    };
  }, [refresh]);
  return {
    data,
    claudeSelection,
    claudeMemberError,
    selection,
    loading,
    error,
    memberError,
    refresh,
    update,
    applyBinding,
  };
}
