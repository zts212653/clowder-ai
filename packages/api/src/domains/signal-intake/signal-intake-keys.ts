export const SignalIntakeKeys = {
  intake: (intakeId: string) => `signal-intake:v1:intake:${intakeId}`,
  allIntakes: () => 'signal-intake:v1:intakes',
  settlement: (settlementKey: string) => `signal-intake:v1:settlement:${settlementKey}`,
  sourceIdentity: (sourceIdentityKey: string) => `signal-intake:v1:source:${sourceIdentityKey}`,
  route: (routeKey: string) => `signal-intake:v1:route:${routeKey}`,
  sourceGrant: (grantHash: string) => `signal-intake:v1:source-grant:${grantHash}`,
} as const;
