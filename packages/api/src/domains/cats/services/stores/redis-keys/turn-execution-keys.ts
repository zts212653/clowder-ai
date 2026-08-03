export const TurnExecutionKeys = {
  record: (invocationId: string) => `turnexec:record:${invocationId}`,
  parent: (parentInvocationId: string) => `turnexec:parent:${parentInvocationId}`,
  running: 'turnexec:running',
} as const;
