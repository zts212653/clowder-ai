import type { CatStatusType } from '@/stores/chat-types';
import { CatAvatar } from './CatAvatar';

const STATUS: Record<CatStatusType, string> = {
  spawning: '已接下',
  pending: '等待开始',
  streaming: '正在思考…',
  done: '已回复',
  error: '回复失败',
  alive_but_silent: '状态待确认',
  suspected_stall: '可能停住了',
};

/** Member progress reads the thread's existing liveness; stop controls remain in the execution row. */
export function IdeateHeader({
  members = [],
}: {
  members?: readonly { catId: string; label: string; status?: CatStatusType }[];
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-cafe bg-cafe-surface px-5 py-2">
      <span className="text-sm font-medium text-cafe-secondary">独立观点采样</span>
      <span className="text-xs text-cafe-muted">本轮各成员独立思考并分别回答，彼此不会互相触发</span>
      {members.length > 0 ? (
        <ul className="mt-1 flex w-full flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="独立思考进度">
          {members.map((member) => (
            <li key={member.catId} className="inline-flex items-center gap-1.5">
              <CatAvatar
                catId={member.catId}
                size={18}
                status={member.status === 'streaming' ? 'streaming' : undefined}
              />
              <span className="text-cafe-secondary">{member.label}</span>
              <span className={member.status === 'error' ? 'text-conn-red-text' : 'text-cafe-muted'}>
                {member.status ? STATUS[member.status] : '状态待确认'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
