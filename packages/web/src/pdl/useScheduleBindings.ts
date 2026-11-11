'use client';
import { useMemo } from 'react';
import { currentScheduleWorks, workCalendarDates, workTitle } from '@/components/growing/work-calendar';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';

export function useScheduleBindings(needed: boolean | number = false) {
  const source = useEntrustedWorkProjection('schedule', needed);
  const ownerReads = useMemo(() => currentScheduleWorks(source.ownerReads), [source.ownerReads]);
  const calendarFacts = useMemo(
    () =>
      ownerReads.map((read) => ({
        id: read.envelope.subjectRef,
        title: workTitle(read),
        dates: workCalendarDates(read),
      })),
    [ownerReads],
  );
  const rawData = useMemo(
    () => ({
      ownerReads,
      calendarFacts,
      loading: source.loading,
      confirmed: source.confirmed,
      error: source.error,
      partial: source.partial,
    }),
    [ownerReads, calendarFacts, source.loading, source.confirmed, source.error, source.partial],
  );
  return {
    data: rawData,
  };
}
