import type { ResolvedContextCapacity } from '../../../../../../config/context-capacity.js';
import type { AgentContextBinding, AgentContextCapability } from '../../../types.js';

export interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
  /** Concrete model/window proof for this service spawn or invocation config. */
  readonly binding?: AgentContextBinding;
  /** Immutable resolver inputs captured at this invocation boundary. */
  readonly memberWindowTokens: number | null;
  /** Captured routing model; only this invocation's verified carrier init may supersede it. */
  readonly model: string | undefined;
  /**
   * #1381: raw/native provider window owned by member configuration (manual or
   * catalog source), captured before any session pin or carrier report applies.
   * This is the ONLY value a provider may inject as its native window; the
   * effective/pinned `capacity.windowTokens` must never feed back as native.
   * `null` means this invocation has no config-owned native window (capacity is
   * report-derived or unresolved) and the provider must not inject one.
   */
  readonly nativeWindowTokens: number | null;
  /**
   * #1381: raw carrier-reported window applied during this invocation, before
   * any resolver floor adjustment. Used to surface (never auto-expand) a
   * session pin sitting below the currently reported capacity — that state may
   * be pre-fix feedback-loop pollution, and recovery stays explicit via
   * seal/rollover.
   */
  readonly lastReportedWindowTokens?: number;
}
