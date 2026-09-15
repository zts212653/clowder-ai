import type { EvolutionProgramProjection } from './evolution-program-projection';

/** Conversation context identifies legacy projects without inventing a goal or copying owner truth. */
export function EvolutionProgramOrigin({ projection }: { projection: EvolutionProgramProjection }) {
  const { origin, program } = projection;
  return (
    <p className="mt-2 text-xs leading-5 text-cafe-secondary">
      {!program.displayName && '尚未命名 · '}
      {origin ? (
        <a className="evolution-link" href={`/thread/${encodeURIComponent(origin.threadId)}`}>
          回到发起对话{program.displayName ? `「${origin.title}」` : ''} ↗
        </a>
      ) : !program.displayName ? (
        '还没有可显示的目标名称，可在项目详情中补充。'
      ) : null}
    </p>
  );
}
