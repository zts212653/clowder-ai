import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BallotIcon } from './icons/VoteIcons';

interface VoteBarState {
  question: string;
  voteCount: number;
  totalVoters: number;
  deadline: number;
  anonymous: boolean;
}

export function VoteActiveBar({ threadId, onEnd }: { threadId: string; onEnd: () => void }) {
  const [vote, setVote] = useState<VoteBarState | null>(null);
  const [remaining, setRemaining] = useState('');

  // Poll vote state
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!data.vote || data.vote.status !== 'active') {
          setVote(null);
          return;
        }
        const v = data.vote;
        setVote({
          question: v.question,
          voteCount: v.voteCount ?? Object.keys(v.votes).length,
          totalVoters: v.voters?.length ?? 0,
          deadline: v.deadline,
          anonymous: v.anonymous,
        });
      } catch {
        /* ignore */
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [threadId]);

  // Countdown timer
  useEffect(() => {
    if (!vote) return;
    const update = () => {
      const diff = Math.max(0, vote.deadline - Date.now());
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [vote]);

  const handleEnd = useCallback(async () => {
    try {
      await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote`, {
        method: 'DELETE',
      });
      setVote(null);
      onEnd();
    } catch {
      /* ignore */
    }
  }, [threadId, onEnd]);

  if (!vote) return null;

  const progressText = vote.totalVoters > 0 ? `已投 ${vote.voteCount}/${vote.totalVoters}` : `已投 ${vote.voteCount}`;

  return (
    <div className="px-4 py-2 bg-conn-amber-bg border-b border-conn-amber-ring flex items-center gap-3 text-sm">
      <BallotIcon className="w-5 h-5 flex-shrink-0 text-conn-amber-text" />
      <span className="font-medium text-conn-amber-text truncate flex-1">投票进行中: {vote.question}</span>
      <span className="text-conn-amber-text flex-shrink-0">
        {progressText} · 剩余 {remaining}
      </span>
      <button
        type="button"
        onClick={handleEnd}
        className="text-xs text-conn-amber-text hover:opacity-90 transition-colors flex-shrink-0"
      >
        结束投票
      </button>
    </div>
  );
}
