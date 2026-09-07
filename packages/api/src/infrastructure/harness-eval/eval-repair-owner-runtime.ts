import type { EvalReleaseTruthResolver } from './eval-release-truth-resolver.js';
import type { EvalRepairApprovalService } from './eval-repair-approval.js';
import {
  createEvalRepairCutover,
  type EvalRepairCutover,
  type EvalRepairCutoverOptions,
} from './eval-repair-cutover.js';
import {
  createEvalRepairEvolutionOwnerPort,
  type EvalRepairEvolutionOwnerPort,
  type EvalRepairEvolutionOwnerPortOptions,
} from './eval-repair-evolution-owner-port.js';
import { EvalRepairOutcomeService } from './eval-repair-outcome.js';
import type { EvalRepairOutcomeServiceOptions } from './eval-repair-outcome-contracts.js';

const DORMANT_EFFECTS = Object.freeze({
  openCase: false,
  approvalProposal: false,
  approvalCard: false,
  task: false,
  f167Lease: false,
  ownerContact: false,
  mutation: false,
  outcome: false,
  decisionEvent: false,
});

export interface EvalRepairOwnerRuntimeBindings {
  resolveOwnerChangeContract: NonNullable<EvalRepairCutoverOptions['ownerResolver']>;
  canonicalRepairDispatcher: NonNullable<EvalRepairCutoverOptions['repairDispatcher']>;
  interventionReceiptOwner: EvalRepairOutcomeServiceOptions['interventionReceiptOwner'];
  freshOutcomeOwner: EvalRepairOutcomeServiceOptions['freshOutcomeOwner'];
  requestAuthorityVerifier: NonNullable<EvalRepairEvolutionOwnerPortOptions['requestAuthorityVerifier']>;
  lineageResolver: NonNullable<EvalRepairEvolutionOwnerPortOptions['lineageResolver']>;
  valueDecisionAuthorityVerifier: NonNullable<EvalRepairEvolutionOwnerPortOptions['valueDecisionAuthorityVerifier']>;
  decisionOwner: NonNullable<EvalRepairEvolutionOwnerPortOptions['decisionOwner']>;
}

/**
 * Canonical asset owners implement this provider outside F266. Resolution is a read-only bootstrap
 * snapshot: it must not contact an owner, create custody, mutate an asset, or append an outcome.
 */
export interface EvalRepairOwnerRuntimeBindingProvider {
  resolve(): Promise<EvalRepairOwnerRuntimeBindings | undefined>;
}

export interface EvalRepairEvolutionOwnerConsumer {
  connect(owner: EvalRepairEvolutionOwnerPort): void;
}

export interface EvalRepairOutcomeServiceConsumer {
  connect(service: EvalRepairOutcomeService): void;
}

interface EvalRepairOwnerRuntimeRegistrationSnapshot {
  bindingProvider?: EvalRepairOwnerRuntimeBindingProvider;
  evolutionOwnerConsumer?: EvalRepairEvolutionOwnerConsumer;
  outcomeServiceConsumer?: EvalRepairOutcomeServiceConsumer;
}

/**
 * Process-local composition wiring only. Canonical owner truth remains behind the provider and the
 * F311 consumer retains refs only; this registration stores neither lifecycle nor decision state.
 */
export class EvalRepairOwnerRuntimeRegistration {
  private bindingProvider?: EvalRepairOwnerRuntimeBindingProvider;
  private evolutionOwnerConsumer?: EvalRepairEvolutionOwnerConsumer;
  private outcomeServiceConsumer?: EvalRepairOutcomeServiceConsumer;

  registerBindingProvider(provider: EvalRepairOwnerRuntimeBindingProvider): void {
    if (this.bindingProvider) throw new Error('eval repair owner binding provider already registered');
    this.bindingProvider = provider;
  }

  registerEvolutionOwnerConsumer(consumer: EvalRepairEvolutionOwnerConsumer): void {
    if (this.evolutionOwnerConsumer) throw new Error('eval repair evolution owner consumer already registered');
    this.evolutionOwnerConsumer = consumer;
  }

  registerOutcomeServiceConsumer(consumer: EvalRepairOutcomeServiceConsumer): void {
    if (this.outcomeServiceConsumer) throw new Error('eval repair outcome service consumer already registered');
    this.outcomeServiceConsumer = consumer;
  }

  snapshot(): EvalRepairOwnerRuntimeRegistrationSnapshot {
    return {
      ...(this.bindingProvider ? { bindingProvider: this.bindingProvider } : {}),
      ...(this.evolutionOwnerConsumer ? { evolutionOwnerConsumer: this.evolutionOwnerConsumer } : {}),
      ...(this.outcomeServiceConsumer ? { outcomeServiceConsumer: this.outcomeServiceConsumer } : {}),
    };
  }
}

export const evalRepairOwnerRuntimeRegistration = new EvalRepairOwnerRuntimeRegistration();

export interface EvalRepairOwnerRuntimeOptions
  extends Omit<EvalRepairCutoverOptions, 'ownerResolver' | 'repairDispatcher'> {
  releaseTruth?: Pick<EvalReleaseTruthResolver, 'loadedRuntimeHead' | 'verifyMainLanded' | 'verifyLiveActive'>;
  registration?: Pick<EvalRepairOwnerRuntimeRegistration, 'snapshot'>;
}

type ActiveCutover = Extract<EvalRepairCutover, { status: 'active' }>;

export type EvalRepairOwnerRuntime =
  | { status: 'dormant'; missing: string[]; effects: typeof DORMANT_EFFECTS }
  | {
      status: 'active';
      cutover: ActiveCutover;
      approvalService: EvalRepairApprovalService;
      outcomeService: EvalRepairOutcomeService;
      evolutionOwner: EvalRepairEvolutionOwnerPort;
    };

const PLATFORM_BINDINGS = [
  'eventLog',
  'approvalIngress',
  'approvalAdapter',
  'epochAuthority',
  'caseActionResolver',
  'releaseTruth',
  'registration',
] as const;

const OWNER_BINDINGS = [
  'resolveOwnerChangeContract',
  'canonicalRepairDispatcher',
  'interventionReceiptOwner',
  'freshOutcomeOwner',
  'requestAuthorityVerifier',
  'lineageResolver',
  'valueDecisionAuthorityVerifier',
  'decisionOwner',
] as const;

function dormant(missing: readonly string[]): EvalRepairOwnerRuntime {
  return { status: 'dormant', missing: [...missing], effects: DORMANT_EFFECTS };
}

function missingPlatformBindings(options: EvalRepairOwnerRuntimeOptions): string[] {
  const missing: string[] = [];
  if (options.lifecycleVersion !== 1) missing.push('lifecycleVersion@1');
  if (options.loaderVersion !== 1) missing.push('loaderVersion@1');
  if (options.routeVersion !== 1) missing.push('routeVersion@1');
  if (options.materializerVersion !== 1) missing.push('materializerVersion@1');
  for (const key of PLATFORM_BINDINGS) {
    if (!options[key]) missing.push(key);
  }
  if (options.approvalAdapter && options.approvalAdapter.featureId !== 'F266') {
    missing.push('approvalAdapter:F266');
  }
  return missing;
}

function missingOwnerBindings(bindings: Partial<EvalRepairOwnerRuntimeBindings> | undefined): string[] {
  if (!bindings) return ['ownerBindings'];
  return OWNER_BINDINGS.filter((key) => !bindings[key]);
}

export async function createEvalRepairOwnerRuntime(
  options: EvalRepairOwnerRuntimeOptions,
): Promise<EvalRepairOwnerRuntime> {
  const platformMissing = missingPlatformBindings(options);
  if (platformMissing.length > 0) return dormant(platformMissing);

  const registration = options.registration?.snapshot();
  const registrationMissing = [
    ...(registration?.bindingProvider ? [] : ['ownerBindingProvider']),
    ...(registration?.evolutionOwnerConsumer ? [] : ['evolutionOwnerConsumer']),
    ...(registration?.outcomeServiceConsumer ? [] : ['outcomeServiceConsumer']),
  ];
  if (registrationMissing.length > 0) return dormant(registrationMissing);

  let bindings: EvalRepairOwnerRuntimeBindings | undefined;
  try {
    bindings = await registration?.bindingProvider?.resolve();
  } catch {
    return dormant(['ownerBindings:unreadable']);
  }
  const ownerMissing = missingOwnerBindings(bindings);
  if (ownerMissing.length > 0) return dormant(ownerMissing);
  if (
    !bindings ||
    !registration?.evolutionOwnerConsumer ||
    !registration.outcomeServiceConsumer ||
    !options.eventLog ||
    !options.caseActionResolver ||
    !options.releaseTruth
  ) {
    throw new Error('complete F313 owner runtime bindings failed to narrow');
  }

  const cutover = await createEvalRepairCutover({
    lifecycleVersion: options.lifecycleVersion,
    loaderVersion: options.loaderVersion,
    routeVersion: options.routeVersion,
    materializerVersion: options.materializerVersion,
    eventLog: options.eventLog,
    approvalIngress: options.approvalIngress,
    approvalAdapter: options.approvalAdapter,
    epochAuthority: options.epochAuthority,
    caseActionResolver: options.caseActionResolver,
    ownerResolver: bindings.resolveOwnerChangeContract,
    repairDispatcher: bindings.canonicalRepairDispatcher,
    ...(options.now ? { now: options.now } : {}),
  });
  if (cutover.status === 'blocked') return dormant(cutover.missing);

  const outcomeService = new EvalRepairOutcomeService({
    eventLog: options.eventLog,
    resolveCaseAction: options.caseActionResolver,
    resolveOwnerChangeContract: bindings.resolveOwnerChangeContract,
    interventionReceiptOwner: bindings.interventionReceiptOwner,
    freshOutcomeOwner: bindings.freshOutcomeOwner,
    releaseTruth: options.releaseTruth,
    ...(options.now ? { now: options.now } : {}),
  });
  const evolution = createEvalRepairEvolutionOwnerPort({
    contractVersion: 1,
    eventLog: options.eventLog,
    approvalService: cutover.service,
    requestAuthorityVerifier: bindings.requestAuthorityVerifier,
    lineageResolver: bindings.lineageResolver,
    valueDecisionAuthorityVerifier: bindings.valueDecisionAuthorityVerifier,
    decisionOwner: bindings.decisionOwner,
    ...(options.now ? { now: options.now } : {}),
  });
  if (evolution.status === 'blocked') return dormant(evolution.missing);
  registration.outcomeServiceConsumer.connect(outcomeService);
  registration.evolutionOwnerConsumer.connect(evolution.port);

  return {
    status: 'active',
    cutover,
    approvalService: cutover.service,
    outcomeService,
    evolutionOwner: evolution.port,
  };
}
