'use strict';

/**
 * The desktop kernel's copy of the Host's admitted companion contract lines (oldest first) and the first line that
 * carries each capability. The Host table lives in
 * packages/api/src/domains/plugin/desktop-window-runtime/published-companion-v2.ts; a test holds the two equal.
 * The kernel keeps its own copy because the launch allowlist is its own fence, independent of the API.
 */
const COMPANION_CONTRACT_LINES = Object.freeze([
  '0.1.0-beta.21',
  '0.1.0-beta.23',
  '0.1.0-beta.24',
  '0.1.0-beta.25',
  '0.1.0-beta.27',
  '0.1.0-beta.28',
  '0.1.0-beta.29',
  '0.3.3-candidate.0',
]);

const COMPANION_CAPABILITY_SINCE = Object.freeze({
  modern: '0.1.0-beta.23',
  unifiedDecisions: '0.1.0-beta.24',
  smallBall: '0.1.0-beta.25',
  presentation: '0.1.0-beta.27',
  letter: '0.1.0-beta.28',
  appAssist: '0.1.0-beta.29',
  desk: '0.3.3-candidate.0',
});

function isCompanionContract(value) {
  return typeof value === 'string' && COMPANION_CONTRACT_LINES.includes(value);
}

function companionContractHas(contract, capability) {
  const since = COMPANION_CAPABILITY_SINCE[capability];
  if (!since) throw new Error(`Unknown companion capability: ${capability}`);
  if (!isCompanionContract(contract)) return false;
  return COMPANION_CONTRACT_LINES.indexOf(contract) >= COMPANION_CONTRACT_LINES.indexOf(since);
}

module.exports = { COMPANION_CONTRACT_LINES, COMPANION_CAPABILITY_SINCE, isCompanionContract, companionContractHas };
