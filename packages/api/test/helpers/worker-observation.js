import { readFileSync, writeFileSync } from 'node:fs';

/** Observe actual worker execution without sharing main-thread globals or changing package bytes. */
export function workerObservation(path, initial) {
  writeFileSync(path, JSON.stringify(initial));
  return {
    read: () => JSON.parse(readFileSync(path, 'utf8')),
    source: `
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const observationPath = ${JSON.stringify(path)};
const state = JSON.parse(readFileSync(observationPath, 'utf8'));
const saveState = () => {
  writeFileSync(observationPath + '.next', JSON.stringify(state));
  renameSync(observationPath + '.next', observationPath);
};
`,
  };
}
