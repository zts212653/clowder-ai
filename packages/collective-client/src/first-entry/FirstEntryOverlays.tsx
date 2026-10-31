import { DemoSpotlight } from './DemoSpotlight.js';
import { EntrySpotlight } from './EntrySpotlight.js';
import type { useFirstEntryGuide } from './use-first-entry-guide.js';

/** Guide overlays share one lifecycle; destination coordination remains in CollectiveWorkspace. */
export function FirstEntryOverlays({
  firstEntry,
  destination,
  channelId,
  onPair,
}: {
  readonly firstEntry: ReturnType<typeof useFirstEntryGuide>;
  readonly destination: string;
  readonly channelId: string;
  readonly onPair: () => void;
}) {
  return (
    <>
      {firstEntry.phase === 'entry' && <EntrySpotlight onPair={onPair} onBrowse={firstEntry.browse} />}
      {firstEntry.phase === 'playing' && destination === 'channel' && channelId === 'general' && (
        <DemoSpotlight
          beat={firstEntry.beat}
          selectedCats={firstEntry.ownCats}
          arrivalComplete={firstEntry.arrivalComplete}
          onNext={firstEntry.next}
          onSkip={firstEntry.finish}
        />
      )}
      {firstEntry.phase === 'handoff' && firstEntry.handoffCaptionVisible && firstEntry.narrator && (
        <section className="demo-caption demo-handoff-caption" data-handoff-caption aria-label="轮到你">
          <h2>换你来</h2>
          <p>@ {firstEntry.narrator.displayName} 试试</p>
        </section>
      )}
    </>
  );
}
