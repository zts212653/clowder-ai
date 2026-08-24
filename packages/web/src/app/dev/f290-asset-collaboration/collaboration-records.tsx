import copy from './product-copy.json';

interface CollaborationRecordsProps {
  selectedId: string;
  onSelect: (id: string) => void;
}

export function CollaborationRecords({ selectedId, onSelect }: CollaborationRecordsProps) {
  const selected = copy.records.find((record) => record.id === selectedId);

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-cafe-subtle bg-cafe-surface-elevated/45"
      aria-label="协同记录"
    >
      <header className="border-b border-cafe-subtle px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-semibold text-cafe-black">协同记录</h2>
          <span className="text-micro text-cafe-muted">8 次往来</span>
        </div>
        <p className="mt-1 text-micro leading-5 text-cafe-muted">从最初批注回看每次取舍与新版本。</p>
      </header>

      <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {copy.records.map((record, index) => {
          const active = record.id === selectedId;
          return (
            <li key={record.id} className="relative pl-5" data-collaboration-record>
              {index < copy.records.length - 1 && (
                <span className="absolute bottom-0 left-[7px] top-4 w-px bg-cafe-border-subtle" aria-hidden="true" />
              )}
              <span
                className={`absolute left-1 top-4 h-2 w-2 rounded-full ring-4 ring-cafe-surface-elevated ${
                  active ? 'bg-cafe-interactive' : 'bg-cafe-muted/55'
                }`}
                aria-hidden="true"
              />
              <button
                type="button"
                data-record-id={record.id}
                aria-current={active ? 'step' : undefined}
                onClick={() => onSelect(record.id)}
                className={`mb-1.5 w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active ? 'bg-cafe-surface shadow-sm ring-1 ring-cafe-border' : 'hover:bg-cafe-surface/70'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-micro font-semibold text-cafe-secondary">{record.actor}</span>
                  <span className="text-micro text-cafe-muted">{record.time}</span>
                  <span className="ml-auto rounded-full bg-cafe-surface-sunken px-1.5 py-0.5 text-micro font-medium text-cafe-secondary">
                    {record.outcome}
                  </span>
                </span>
                <span className="mt-1 block text-xs font-medium leading-5 text-cafe-black">{record.title}</span>
              </button>
              <a
                href={record.sourceUrl}
                target="_blank"
                rel="noreferrer"
                data-record-source
                className="mb-2.5 ml-2 inline-flex text-micro font-medium text-cafe-interactive hover:underline"
              >
                查看原文
              </a>
            </li>
          );
        })}
      </ol>

      {selected && (
        <section className="border-t border-cafe-subtle bg-cafe-surface px-4 py-3" data-active-record={selected.id}>
          <p className="text-micro font-semibold text-cafe-interactive">{selected.kind}</p>
          <h3 className="mt-1 text-xs font-semibold leading-5 text-cafe-black">{selected.title}</h3>
          <p className="mt-1 text-micro leading-5 text-cafe-secondary">{selected.detail}</p>
        </section>
      )}
    </aside>
  );
}
