import type {
  FreshnessAttentionEvent,
  ProviderNativeFreshnessCarrier,
  ProviderNativeFreshnessDeliverySemantics,
  ProviderNativeFreshnessProvider,
  ProviderNativeFreshnessToolSurface,
} from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';

const REQUIRED_SURFACES_BY_PROVIDER: Readonly<
  Partial<Record<ProviderNativeFreshnessProvider, readonly ProviderNativeFreshnessToolSurface[]>>
> = {
  openai_codex: [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'dynamic_tool_call',
    'collab_agent_tool_call',
    'web_search',
    'image_view',
    'image_generation',
    'sleep',
  ],
  anthropic: ['command_execution', 'file_change', 'mcp_tool_call', 'dynamic_tool_call'],
};

export interface ProviderNativeFreshnessCoverageCell {
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  toolSurface: ProviderNativeFreshnessToolSurface;
  observedCount: number;
  opportunityCount: number;
  deliveredCount: number;
  missedCount: number;
  seenCount: number;
  handledCount: number;
}

export interface ProviderNativeFreshnessCarrierCoverage {
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  dataStatus: 'no_data' | 'observed';
  allToolCoverage: boolean;
  missingSurfaces: ProviderNativeFreshnessToolSurface[];
  unknownItemCount: number;
}

export interface ProviderNativeFreshnessCoverageReport {
  cells: ProviderNativeFreshnessCoverageCell[];
  carriers: ProviderNativeFreshnessCarrierCoverage[];
  verdict: 'no_data' | 'partial' | 'all_tool_covered';
}

type ProviderNativeNoticeEvent = Extract<
  FreshnessAttentionEvent,
  {
    kind:
      | 'provider_notice_opportunity'
      | 'provider_notice_prepared'
      | 'provider_notice_delivered'
      | 'provider_notice_missed'
      | 'provider_notice_seen'
      | 'provider_notice_handled';
  }
>;
type ProviderCapabilityEvent = Extract<FreshnessAttentionEvent, { kind: 'provider_carrier_capability_declared' }>;
type ProviderObservationEvent = Extract<FreshnessAttentionEvent, { kind: 'provider_protocol_item_observed' }>;
type ProviderEvent = ProviderNativeNoticeEvent | ProviderCapabilityEvent | ProviderObservationEvent;

function isProviderEvent(event: FreshnessAttentionEvent): event is ProviderEvent {
  return event.kind.startsWith('provider_') && 'provider' in event && 'carrier' in event;
}

function carrierKey(event: Pick<ProviderEvent, 'provider' | 'carrier' | 'deliverySemantics'>): string {
  return [event.provider, event.carrier, event.deliverySemantics].join('\0');
}

function cellKey(
  event: Pick<ProviderEvent, 'provider' | 'carrier' | 'deliverySemantics'>,
  toolSurface: ProviderNativeFreshnessToolSurface,
): string {
  return `${carrierKey(event)}\0${toolSurface}`;
}

function incrementCell(
  cell: ProviderNativeFreshnessCoverageCell,
  event: Exclude<ProviderEvent, ProviderCapabilityEvent>,
) {
  if (event.kind === 'provider_protocol_item_observed') cell.observedCount++;
  else if (event.kind === 'provider_notice_opportunity') cell.opportunityCount++;
  else if (event.kind === 'provider_notice_delivered') cell.deliveredCount++;
  else if (event.kind === 'provider_notice_missed') cell.missedCount++;
  else if (event.kind === 'provider_notice_seen') cell.seenCount++;
  else if (event.kind === 'provider_notice_handled') cell.handledCount++;
}

function collectCoverageCells(providerEvents: readonly ProviderEvent[]): ProviderNativeFreshnessCoverageCell[] {
  const cells = new Map<string, ProviderNativeFreshnessCoverageCell>();
  for (const event of providerEvents) {
    if (event.kind === 'provider_carrier_capability_declared') continue;
    const key = cellKey(event, event.toolSurface);
    const cell = cells.get(key) ?? {
      provider: event.provider,
      carrier: event.carrier,
      deliverySemantics: event.deliverySemantics,
      toolSurface: event.toolSurface,
      observedCount: 0,
      opportunityCount: 0,
      deliveredCount: 0,
      missedCount: 0,
      seenCount: 0,
      handledCount: 0,
    };
    incrementCell(cell, event);
    cells.set(key, cell);
  }
  return [...cells.values()].sort((left, right) =>
    [left.provider, left.carrier, left.deliverySemantics, left.toolSurface]
      .join(':')
      .localeCompare([right.provider, right.carrier, right.deliverySemantics, right.toolSurface].join(':')),
  );
}

function projectCarrierCoverage(
  seed: Pick<ProviderEvent, 'provider' | 'carrier' | 'deliverySemantics'>,
  cells: readonly ProviderNativeFreshnessCoverageCell[],
): ProviderNativeFreshnessCarrierCoverage {
  const siblings = cells.filter(
    (candidate) =>
      candidate.provider === seed.provider &&
      candidate.carrier === seed.carrier &&
      candidate.deliverySemantics === seed.deliverySemantics,
  );
  const required = REQUIRED_SURFACES_BY_PROVIDER[seed.provider] ?? [];
  const missingSurfaces = required.filter(
    (surface) => !siblings.some((candidate) => candidate.toolSurface === surface && candidate.seenCount > 0),
  );
  const unknownItemCount = siblings
    .filter((candidate) => candidate.toolSurface === 'unknown')
    .reduce((sum, candidate) => sum + candidate.observedCount, 0);
  return {
    provider: seed.provider,
    carrier: seed.carrier,
    deliverySemantics: seed.deliverySemantics,
    dataStatus: siblings.length === 0 ? 'no_data' : 'observed',
    allToolCoverage:
      seed.deliverySemantics === 'exact_active_turn' &&
      required.length > 0 &&
      missingSurfaces.length === 0 &&
      unknownItemCount === 0,
    missingSurfaces: [...missingSurfaces],
    unknownItemCount,
  };
}

function coverageVerdict(carriers: readonly ProviderNativeFreshnessCarrierCoverage[]) {
  if (carriers.length === 0 || carriers.every((carrier) => carrier.dataStatus === 'no_data')) return 'no_data';
  return carriers.some((carrier) => carrier.allToolCoverage) ? 'all_tool_covered' : 'partial';
}

export function buildProviderNativeFreshnessCoverage(
  events: readonly FreshnessAttentionEvent[],
): ProviderNativeFreshnessCoverageReport {
  const providerEvents = events.filter(isProviderEvent);
  const sortedCells = collectCoverageCells(providerEvents);
  const carrierSeeds = new Map<string, Pick<ProviderEvent, 'provider' | 'carrier' | 'deliverySemantics'>>();
  for (const event of providerEvents) carrierSeeds.set(carrierKey(event), event);
  const carriers: ProviderNativeFreshnessCarrierCoverage[] = [...carrierSeeds.values()]
    .map((seed) => projectCarrierCoverage(seed, sortedCells))
    .sort((left, right) =>
      [left.provider, left.carrier, left.deliverySemantics]
        .join(':')
        .localeCompare([right.provider, right.carrier, right.deliverySemantics].join(':')),
    );

  return {
    cells: sortedCells,
    carriers,
    verdict: coverageVerdict(carriers),
  };
}
