/**
 * Which response R a route in this process still has to commit (PR-3a, Astra #6697 R2).
 *
 * A route enters a child turn here before that turn's R is admitted, and leaves once its own terminal
 * commit of R has run — or when the route exits, however it exits. While a turn is here, its R
 * belongs to that route: any other writer would make the route's commit meet a second terminal
 * (`different_terminal`) and report the turn's output as unsaved. Stop and repair paths read this
 * before they end a turn or its R; nothing else depends on it, and it never blocks the route.
 *
 * Writers after the route (the Queue's abandoned-response settlement, the zombie reaper, startup
 * recovery) all settle through `settleResponseFromDraft`, which keeps an R another writer ended and
 * never reports that as a failure, so they need no entry here.
 *
 * Process-local, like the session mutex: after a restart no route of the old process can commit.
 */
export class ResponseProducerRegistry {
  private readonly producers = new Map<string, number>();

  /** Whether a live route will still commit the R of this child turn. */
  has(invocationId: string): boolean {
    return this.producers.has(invocationId);
  }

  /** One route's holdings; it releases each turn after its commit and the rest when it exits. */
  openRouteScope(): RouteResponseProducers {
    return new RouteResponseProducers(this);
  }

  /** @internal Paired enter/leave only through a route scope. */
  enter(invocationId: string): void {
    this.producers.set(invocationId, (this.producers.get(invocationId) ?? 0) + 1);
  }

  /** @internal */
  leave(invocationId: string): void {
    const count = this.producers.get(invocationId);
    if (count === undefined) return;
    if (count <= 1) this.producers.delete(invocationId);
    else this.producers.set(invocationId, count - 1);
  }
}

export class RouteResponseProducers {
  private readonly held = new Set<string>();

  constructor(private readonly registry: ResponseProducerRegistry) {}

  /** This route will commit this turn's R. Idempotent per turn. */
  enter(invocationId: string): void {
    if (this.held.has(invocationId)) return;
    this.held.add(invocationId);
    this.registry.enter(invocationId);
  }

  /** Wraps a route's R admission so each turn is claimed before its R exists. */
  claimingAdmission<Input extends { invocationId: string }, Result>(
    admit: (input: Input) => Result,
  ): (input: Input) => Result {
    return (input) => {
      this.enter(input.invocationId);
      return admit(input);
    };
  }

  /** This route has made its own terminal commit of this turn's R (or will not make one). */
  leave(invocationId: string): void {
    if (!this.held.delete(invocationId)) return;
    this.registry.leave(invocationId);
  }

  /** The route exits: nothing it held can still be committed by it. */
  leaveAll(): void {
    for (const invocationId of [...this.held]) this.leave(invocationId);
  }
}

export const responseProducers = new ResponseProducerRegistry();
