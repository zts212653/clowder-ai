import assert from 'node:assert/strict';
import { parseMacSleepEvidence } from '../../runtime/process-observation/mac-power-evidence.mjs';

export function parseNativePowerLog(output) {
  const evidence = parseMacSleepEvidence(output);
  assert.equal(evidence.status, 'available');
  return evidence.confirmedSleep;
}
