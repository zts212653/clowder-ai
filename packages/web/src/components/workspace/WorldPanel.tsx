'use client';

import { useCallback, useEffect, useState } from 'react';

type WorldMode = 'build' | 'perform' | 'replay';

interface WorldSummary {
  worldId: string;
  name: string;
  status: string;
  constitution?: string;
}

interface CharacterSummary {
  characterId: string;
  coreIdentity?: { name?: string; role?: string };
  innerDrive?: { motivation?: string };
}

interface WorldEvent {
  eventId: string;
  type: string;
  actor: { kind: string; id: string };
  payload: Record<string, unknown>;
  createdAt: string;
}

interface WorldPanelProps {
  worldId: string;
  apiBase?: string;
}

const MODE_LABELS: Record<WorldMode, string> = {
  build: 'Build',
  perform: 'Perform',
  replay: 'Replay',
};

export function WorldPanel({ worldId, apiBase = '' }: WorldPanelProps) {
  const [mode, setMode] = useState<WorldMode>('build');
  const [world, setWorld] = useState<WorldSummary | null>(null);
  const [characters] = useState<CharacterSummary[]>([]);
  const [events] = useState<WorldEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchWorld = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}`);
      if (!res.ok) {
        setError('World not found');
        return;
      }
      setWorld(await res.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [worldId, apiBase]);

  useEffect(() => {
    fetchWorld();
  }, [fetchWorld]);

  return (
    <div className="flex flex-col h-full bg-cafe-surface/80 text-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#FFDDD2]">
        <span className="font-semibold text-cafe-primary">{world?.name ?? worldId}</span>
        <span className="text-xs text-cafe-secondary">[{world?.status ?? '...'}]</span>
        <div className="ml-auto flex gap-1">
          {(Object.keys(MODE_LABELS) as WorldMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                mode === m
                  ? 'bg-cafe-primary text-white'
                  : 'bg-cafe-surface hover:bg-cafe-primary/10 text-cafe-secondary'
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="px-3 py-2 text-red-600 text-xs bg-red-50/50">{error}</div>}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {mode === 'build' && <BuildView world={world} characters={characters} />}
        {mode === 'perform' && <PerformView world={world} events={events} />}
        {mode === 'replay' && <ReplayView events={events} />}
      </div>
    </div>
  );
}

function BuildView({ world, characters }: { world: WorldSummary | null; characters: CharacterSummary[] }) {
  return (
    <div className="space-y-3">
      {world?.constitution && (
        <section>
          <h3 className="text-xs font-semibold text-cafe-secondary uppercase tracking-wider mb-1">Constitution</h3>
          <p className="text-cafe-primary text-xs leading-relaxed">{world.constitution}</p>
        </section>
      )}
      <section>
        <h3 className="text-xs font-semibold text-cafe-secondary uppercase tracking-wider mb-1">
          Characters ({characters.length})
        </h3>
        {characters.length === 0 ? (
          <p className="text-cafe-secondary text-xs italic">No characters yet</p>
        ) : (
          <ul className="space-y-1">
            {characters.map((ch) => (
              <li key={ch.characterId} className="text-xs">
                <span className="font-medium text-cafe-primary">{ch.coreIdentity?.name ?? ch.characterId}</span>
                {ch.coreIdentity?.role && <span className="text-cafe-secondary ml-1">({ch.coreIdentity.role})</span>}
                {ch.innerDrive?.motivation && (
                  <span className="text-cafe-secondary ml-1">— {ch.innerDrive.motivation}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PerformView({ world, events }: { world: WorldSummary | null; events: WorldEvent[] }) {
  const recentEvents = events.slice(-5);
  return (
    <div className="space-y-3">
      <section>
        <h3 className="text-xs font-semibold text-cafe-secondary uppercase tracking-wider mb-1">Active Scene</h3>
        <p className="text-cafe-primary text-xs">{world?.name ?? 'Loading...'}</p>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-cafe-secondary uppercase tracking-wider mb-1">
          Recent ({recentEvents.length})
        </h3>
        {recentEvents.length === 0 ? (
          <p className="text-cafe-secondary text-xs italic">No events yet</p>
        ) : (
          <EventList events={recentEvents} />
        )}
      </section>
    </div>
  );
}

function ReplayView({ events }: { events: WorldEvent[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-cafe-secondary uppercase tracking-wider mb-2">
        Event Log ({events.length})
      </h3>
      {events.length === 0 ? (
        <p className="text-cafe-secondary text-xs italic">No events recorded</p>
      ) : (
        <EventList events={events} />
      )}
    </div>
  );
}

function EventList({ events }: { events: WorldEvent[] }) {
  return (
    <ul className="space-y-1.5">
      {events.map((ev) => (
        <li key={ev.eventId} className="text-xs border-l-2 border-cafe-primary/30 pl-2 py-0.5">
          <div className="flex items-center gap-1">
            <span className="font-mono text-cafe-secondary">[{ev.type}]</span>
            <span className="text-cafe-secondary">{ev.actor.id}</span>
            <span className="text-cafe-secondary/50 ml-auto text-[10px]">{ev.createdAt.slice(11, 19)}</span>
          </div>
          {'content' in ev.payload && ev.payload.content != null && (
            <p className="text-cafe-primary mt-0.5 leading-relaxed">{String(ev.payload.content).slice(0, 200)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
