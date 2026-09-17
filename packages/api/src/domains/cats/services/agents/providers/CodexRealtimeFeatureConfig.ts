export const REALTIME_CONVERSATION_FEATURE = 'realtime_conversation';
const REALTIME_CONVERSATION_CONFIG_KEY = `features.${REALTIME_CONVERSATION_FEATURE}`;

/** Realtime remains an Alpha-only server capability, never a member CLI override. */
export function isNativeRealtimeCompanionDeployment(deploymentId: string | undefined): boolean {
  return deploymentId === 'alpha';
}

export function buildCodexRealtimeFeatureArgs(enabled: boolean): string[] {
  return enabled ? ['--enable', REALTIME_CONVERSATION_FEATURE] : [];
}

export function isReservedRealtimeFeature(feature: string): boolean {
  return feature === REALTIME_CONVERSATION_FEATURE;
}

export function isReservedRealtimeConfigKey(key: string): boolean {
  return key === REALTIME_CONVERSATION_CONFIG_KEY || key.startsWith(`${REALTIME_CONVERSATION_CONFIG_KEY}.`);
}
