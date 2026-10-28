import Link from 'next/link';
import { MemoryOwnerSource } from './MemoryOwnerControls';

export function MemoryProfileSource({ endpoint, opening = false }: { endpoint: string; opening?: boolean }) {
  return (
    <section className="space-y-3 border-t border-cafe-subtle pt-3 text-compact">
      <h4 className="text-xs font-medium text-cafe-muted">{opening ? '什么时候带上 · 出处' : '使用记录 · 出处'}</h4>
      {opening && <p className="text-cafe-muted">每场新对话开始时带上这段；已经开始的对话不会重新加入。</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-cafe-muted">
        <span>这份画像的使用次数尚未汇总</span>
        <Link href="/memory?tab=recall" className="shell-focusable text-cafe-accent underline">
          查看召回记录
        </Link>
      </div>
      <MemoryOwnerSource endpoint={endpoint} />
    </section>
  );
}
