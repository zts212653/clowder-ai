'use client';

import { useRouter } from 'next/navigation';
import { useChatStore } from '@/stores/chatStore';

export function OpenTeamWorkspaceButton() {
  const router = useRouter();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const openTeamSubject = useChatStore((state) => state.openTeamSubject);

  return (
    <button
      type="button"
      onClick={() => {
        openTeamSubject(null);
        router.push(currentThreadId ? `/thread/${encodeURIComponent(currentThreadId)}` : '/');
      }}
      className="h-8 rounded-lg border border-cafe-accent/35 px-3 text-micro font-semibold text-cafe-accent hover:bg-cafe-accent/8"
      data-testid="settings-open-team"
    >
      打开猫猫团队
    </button>
  );
}
