import type { SubscriptionDelivery } from './subscription-delivery.js';

/** Late-bound, fire-and-forget bridge from durable publication to live subscribers. */
export class SubscriptionDrainScheduler {
  private delivery: Pick<SubscriptionDelivery, 'drain'> | undefined;

  constructor(private readonly onFailure: (error: unknown, threadId: string) => void) {}

  attach(delivery: Pick<SubscriptionDelivery, 'drain'>): void {
    this.delivery = delivery;
  }

  schedule = (threadId: string): void => {
    const delivery = this.delivery;
    if (!delivery) return;
    void delivery.drain(threadId).catch((error) => this.onFailure(error, threadId));
  };
}
