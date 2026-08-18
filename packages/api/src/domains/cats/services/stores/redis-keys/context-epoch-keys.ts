export const ContextEpochKeys = {
  /** One hash per `user × cat × thread` scope. */
  scope: (scopeKey: string) => `context-epoch:scope:${scopeKey}`,
} as const;
