/** Observe the content end: a message taller than the viewport can never reach a 50% whole-message ratio. */
export function MessageReadEnd({ eventId }: { eventId: string }) {
  return <span data-event-read-end={eventId} aria-hidden="true" style={{ display: 'block', height: 1 }} />;
}
