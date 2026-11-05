/** Persisted desktop failure vocabulary, independent of runtime executors and package loading. */
export type DesktopWindowFailureReason =
  | 'renderer-gone'
  | 'unresponsive'
  | 'window-closed'
  | 'process-exit'
  | 'request-timeout'
  | 'protocol-violation'
  | 'connection-ended'
  | 'heartbeat-expired'
  | 'poll-failed'
  | 'surface-unavailable'
  | 'unknown';
