import { INVALID_PARAMS_CODE, WIRE_METHOD_REGISTRY } from '@clowder-ai/plugin-contract';
import { M0C_BEHAVIOR_CASE_IDS } from '@clowder-ai/plugin-contract/conformance';

export const M0D_PROTOCOL_CASE_IDS = M0C_BEHAVIOR_CASE_IDS;

export class M0dExecutionPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'M0dExecutionPlanError';
  }
}

function planError(message) {
  throw new M0dExecutionPlanError(message);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) planError(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function behaviorOracle(value) {
  const oracle = record(value, 'behavior verdict oracle');
  return exactKeys(oracle, ['kind']) && oracle.kind === 'behavior-expectation';
}

function admissionOracle(value) {
  const oracle = record(value, 'wire-admission verdict oracle');
  return (
    exactKeys(oracle, ['kind', 'code', 'sideEffects']) &&
    oracle.kind === 'json-rpc-error' &&
    oracle.code === INVALID_PARAMS_CODE &&
    oracle.sideEffects === 'behavior-expectation'
  );
}

function pluginToHostMethod(method) {
  return typeof method === 'string' && WIRE_METHOD_REGISTRY[method]?.direction === 'plugin-to-host';
}

function requireExecutionKeys(caseId, execution, expected, label) {
  if (!exactKeys(execution, expected)) planError(`${caseId} ${label} execution has unsupported fields`);
}

function validatePluginToHost(caseId, execution) {
  requireExecutionKeys(caseId, execution, ['plane', 'method', 'verdictOracle'], 'plugin-to-host');
  if (!pluginToHostMethod(execution.method)) planError(`${caseId} has an invalid plugin-to-host method`);
  if (!behaviorOracle(execution.verdictOracle)) planError(`${caseId} has an invalid behavior oracle`);
}

function validateWireAdmission(caseId, execution) {
  requireExecutionKeys(caseId, execution, ['plane', 'method', 'verdictOracle'], 'wire-admission');
  if (!pluginToHostMethod(execution.method)) planError(`${caseId} has an invalid wire-admission method`);
  if (!admissionOracle(execution.verdictOracle)) planError(`${caseId} has an invalid wire-admission oracle`);
}

function validateHostDelivery(caseId, execution) {
  requireExecutionKeys(caseId, execution, ['plane', 'method', 'verdictOracle'], 'Host delivery');
  if (execution.method !== 'host.messaging.deliver') planError(`${caseId} has an invalid Host delivery method`);
  if (!behaviorOracle(execution.verdictOracle)) planError(`${caseId} has an invalid behavior oracle`);
}

function validateHostControl(caseId, execution) {
  if (Object.hasOwn(execution, 'method')) planError(`${caseId} host-control method must be absent`);
  requireExecutionKeys(caseId, execution, ['plane', 'verdictOracle'], 'host-control');
  if (!behaviorOracle(execution.verdictOracle)) planError(`${caseId} has an invalid behavior oracle`);
}

const EXECUTION_VALIDATORS = Object.freeze({
  'plugin-to-host-wire': validatePluginToHost,
  'wire-admission': validateWireAdmission,
  'host-to-plugin-delivery': validateHostDelivery,
  'host-control': validateHostControl,
});

function validateExecution(caseId, value) {
  const execution = record(value, `${caseId} execution metadata`);
  const validate = EXECUTION_VALIDATORS[execution.plane];
  if (!validate) {
    planError(`${caseId} has an unsupported execution plane ${String(execution.plane)}`);
  }
  validate(caseId, execution);
  const verdictOracle = Object.freeze(structuredClone(execution.verdictOracle));
  return Object.freeze({ ...structuredClone(execution), verdictOracle });
}

export function loadM0dExecutionPlan(fixture, expectedIds = M0D_PROTOCOL_CASE_IDS) {
  const published = record(fixture, 'M0-D behavior fixture');
  if (!Array.isArray(published.cases)) planError('M0-D behavior fixture cases must be an array');
  const seen = new Set();
  for (const candidate of published.cases) {
    const behaviorCase = record(candidate, 'M0-D behavior case');
    if (typeof behaviorCase.id !== 'string' || behaviorCase.id.length === 0) planError('behavior case id is missing');
    if (seen.has(behaviorCase.id)) planError(`duplicate case id ${behaviorCase.id}`);
    seen.add(behaviorCase.id);
  }
  if (published.cases.length !== expectedIds.length) {
    planError(`execution plan count ${published.cases.length} does not match canonical count ${expectedIds.length}`);
  }
  const plan = published.cases.map((candidate, index) => {
    const expectedId = expectedIds[index];
    if (candidate.id !== expectedId) {
      planError(`execution plan is not in canonical order: expected ${expectedId}, received ${candidate.id}`);
    }
    if (!Object.hasOwn(candidate, 'execution')) planError(`${candidate.id} is missing execution metadata`);
    return Object.freeze({ id: candidate.id, execution: validateExecution(candidate.id, candidate.execution) });
  });
  return Object.freeze(plan);
}
