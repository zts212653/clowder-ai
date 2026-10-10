/**
 * F322 original-B: the draggable list of queue entries, shared by the old QueuePanel and the one-row panel.
 * Every per-entry control (remind, steer, retry, withdraw, recall-edit, force-reset, per-target chips, carrier
 * detail, images, connector labels) lives in QueueEntryRow, so reusing it keeps them all by construction.
 */
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { deliveredTargetIdsFromHistory, SortableQueueEntryRow } from '../QueueEntryRow';
import type { useQueueActionConvergence } from '../useQueueActionConvergence';
import type { useQueueCommands } from './useQueueCommands';
import type { QueueView } from './useQueueView';

interface QueueEntryListProps {
  view: Pick<QueueView, 'threadId' | 'visibleEntries'>;
  commands: ReturnType<typeof useQueueCommands>;
  convergence: Pick<ReturnType<typeof useQueueActionConvergence>, 'handleSteerOpen'>;
  resolveCatName: (catId: string) => string;
  className: string;
}

export function QueueEntryList({ view, commands, convergence, resolveCatName, className }: QueueEntryListProps) {
  const coCreator = useCoCreatorConfig();
  const timelineMessages = useThreadMessages(view.threadId);
  const { cats } = useCatData();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const entryIds = view.visibleEntries.filter((entry) => entry.status === 'queued').map((entry) => entry.id);
  const onDragEnd = (event: DragEndEvent) => void commands.handleDragEnd(event);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {view.visibleEntries.map((entry, idx) => {
            // #706: Compute image count from server-enriched messagePreview
            const imageCount = entry.messagePreview?.contentBlocks?.filter((b) => b.type === 'image').length ?? 0;
            return (
              <SortableQueueEntryRow
                key={entry.id}
                entry={entry}
                index={idx}
                imageCount={imageCount}
                ownerName={coCreator.name}
                ownerAvatar={coCreator.avatar}
                deliveredTargetIds={
                  entry.messageId ? deliveredTargetIdsFromHistory(entry.messageId, timelineMessages) : []
                }
                resolveCatName={resolveCatName}
                resolveCatAvatar={(id) => cats.find((cat) => cat.id === id)?.avatar}
                onRemove={commands.handleRemove}
                onRecallEdit={commands.handleRecallEdit}
                onSteer={convergence.handleSteerOpen}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
