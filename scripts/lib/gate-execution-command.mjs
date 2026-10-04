export const GATE_EXECUTION_ADMISSION_PROTOCOL = 's3-owned-resource-transparent-v1';
export const GATE_EXECUTION_EVIDENCE_SCOPE = 'exact-head-durable';
export const GATE_EXECUTION_MAX_CLEANUP_BUDGET_MS = 30_000;
export const GATE_EXECUTION_SLEEP_RECOVERY_PROTOCOL_VERSION = 2;

export const LEGACY_GATE_RESOURCE_ENV_KEYS = Object.freeze([
  'CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD',
  'CAT_CAFE_FULL_GATE_RESOURCE_MODE',
  'CAT_CAFE_FULL_GATE_RESOURCE_PRIORITY',
  'CAT_CAFE_FULL_GATE_RESOURCE_STAGE',
  'CAT_CAFE_FULL_GATE_RESOURCE_CLASS',
  'CAT_CAFE_FULL_GATE_RESOURCE_CLAIMS',
]);

const RESOURCE_OWNING_WRAPPERS = Object.freeze([
  'run-with-gate-resource-permit.mjs',
  'run-with-gate-resource-lease.mjs',
  'run-with-node-env-test.mjs',
  'run_gate_resource_stage',
]);

function validCommand(command) {
  return (
    command &&
    typeof command.cwd === 'string' &&
    command.cwd.length > 0 &&
    !command.cwd.includes('\0') &&
    Array.isArray(command.argv) &&
    command.argv.length > 0 &&
    command.argv.every((argument) => typeof argument === 'string' && argument.length > 0 && !argument.includes('\0')) &&
    command.env &&
    typeof command.env === 'object' &&
    !Array.isArray(command.env) &&
    Object.values(command.env).every((value) => typeof value === 'string')
  );
}

export function assertResourceTransparentGateCommand(command, { label, requireBrowserTestEnv = false } = {}) {
  const commandLabel = label ?? 'gate command';
  if (!validCommand(command)) throw new Error(`Invalid ${commandLabel}`);
  const resourceWrapper = RESOURCE_OWNING_WRAPPERS.find((name) =>
    command.argv.some((argument) => argument.includes(name)),
  );
  if (resourceWrapper) {
    throw new Error(`${commandLabel} contains resource-owning wrapper ${resourceWrapper}; S3 owns admission`);
  }
  const permitMarker = LEGACY_GATE_RESOURCE_ENV_KEYS.find((key) => Object.hasOwn(command.env, key));
  if (permitMarker) throw new Error(`${commandLabel} must not forge legacy permit marker ${permitMarker}`);
  if (requireBrowserTestEnv && (command.env.NODE_ENV !== 'test' || command.env.CAT_CAFE_DEPLOYMENT_ID !== 'test')) {
    throw new Error(`${commandLabel} must explicitly set NODE_ENV=test and CAT_CAFE_DEPLOYMENT_ID=test`);
  }
}

export function assertGateExecutionPlanAdmission(plan) {
  if (plan?.admissionProtocol !== GATE_EXECUTION_ADMISSION_PROTOCOL) {
    throw new Error(`Gate ExecutionPlan requires admission protocol ${GATE_EXECUTION_ADMISSION_PROTOCOL}`);
  }
  if (plan.evidenceScope !== GATE_EXECUTION_EVIDENCE_SCOPE) {
    throw new Error(`Gate ExecutionPlan requires evidence scope ${GATE_EXECUTION_EVIDENCE_SCOPE}`);
  }
  const preparationIds = new Set((plan.preparations ?? []).map((preparation) => preparation.preparationId));
  for (const unit of plan.units ?? []) {
    assertResourceTransparentGateCommand(unit.command, {
      label: `browser unit ${unit.unitId}`,
      requireBrowserTestEnv: true,
    });
    if (
      !Array.isArray(unit.preparationIds) ||
      unit.preparationIds.some((preparationId) => !preparationIds.has(preparationId))
    ) {
      throw new Error(`browser unit ${unit.unitId} references an unknown gate preparation`);
    }
    if (
      !Number.isSafeInteger(unit.cleanupBudgetMs) ||
      unit.cleanupBudgetMs <= 0 ||
      unit.cleanupBudgetMs > GATE_EXECUTION_MAX_CLEANUP_BUDGET_MS
    ) {
      throw new Error(`browser unit ${unit.unitId} cleanup budget exceeds ${GATE_EXECUTION_MAX_CLEANUP_BUDGET_MS}ms`);
    }
  }
  for (const preparation of plan.preparations ?? []) {
    assertResourceTransparentGateCommand(preparation.command, {
      label: `gate preparation ${preparation.preparationId}`,
    });
  }
}

export function assertGateExecutionSleepRecoveryProtocol(plan) {
  if (plan?.sleepRecoveryProtocolVersion !== GATE_EXECUTION_SLEEP_RECOVERY_PROTOCOL_VERSION) {
    throw new Error('gate ExecutionPlan does not support sleep recovery');
  }
}

export function gateExecutionSleepRecoveryProtocolVersion(plan) {
  return plan?.sleepRecoveryProtocolVersion === undefined ? 1 : plan.sleepRecoveryProtocolVersion;
}

export function assertGateExecutionClaimProtocol(plan, persistedVersion) {
  const planVersion = gateExecutionSleepRecoveryProtocolVersion(plan);
  if (persistedVersion !== planVersion || ![1, GATE_EXECUTION_SLEEP_RECOVERY_PROTOCOL_VERSION].includes(planVersion)) {
    throw new Error('unsupported gate execution recovery protocol for this worker');
  }
}

export function assertNoOuterGateResourcePermit(environment = process.env) {
  const inherited = LEGACY_GATE_RESOURCE_ENV_KEYS.filter((key) => environment[key] !== undefined);
  if (inherited.length) {
    throw new Error(
      `S3 gate execution cannot run inside a legacy resource permit; remove outer admission markers: ${inherited.join(', ')}`,
    );
  }
}
