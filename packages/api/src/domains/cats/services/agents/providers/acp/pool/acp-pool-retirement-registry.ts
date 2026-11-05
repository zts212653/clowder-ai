/** Registry membership is a service projection, not proof that a prior native writer exited. */
const retirements = new WeakMap<object, Map<string, Promise<void>>>();

export function pendingAcpPoolRetirement(registry: object, profileId: string): Promise<void> | undefined {
  return retirements.get(registry)?.get(profileId);
}

export function trackAcpPoolRetirement(registry: object, profileId: string, completion: Promise<void>): void {
  const profiles = retirements.get(registry) ?? new Map<string, Promise<void>>();
  retirements.set(registry, profiles);
  const previous = profiles.get(profileId);
  const finished = Promise.all([previous, completion]).then(() => {});
  profiles.set(profileId, finished);
  void finished.then(
    () => {
      if (profiles.get(profileId) === finished) profiles.delete(profileId);
    },
    () => {
      // Preserve an unconfirmed exit across rollback/deactivation and any later admission.
    },
  );
}
