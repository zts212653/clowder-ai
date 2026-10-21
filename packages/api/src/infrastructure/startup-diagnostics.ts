/** Desktop preload can measure work before this module graph finishes. */
export function startupMilestone(phase: string): void {
  const callback = (globalThis as { __clowderStartupMilestone?: (phase: string) => void }).__clowderStartupMilestone;
  callback?.(phase);
}
