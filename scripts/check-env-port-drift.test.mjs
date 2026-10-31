/**
 * Port drift guard — ensures .env.example.opensource ports stay consistent
 * with sync-to-opensource.sh transforms.
 *
 * Root cause of clowder-ai#87 / #55 / #56: the .env.example.opensource had
 * API_SERVER_PORT and FRONTEND_PORT swapped relative to the code defaults
 * that sync-to-opensource.sh produces. This test prevents that from recurring.
 *
 * Convention (set by _sanitize-rules.pl + sync-to-opensource.sh):
 *   Home:        API=3002, Frontend=3001
 *   Open-source: API=3004, Frontend=3003
 *   Redis:       stays 6399 in both repos
 *   (API = Frontend + 1 in both environments)
 */
import { describe } from 'node:test';
import { registerCodeDefaultsPart1 } from './port-drift/code-defaults-1.mjs';
import {
  expectedApiPort,
  expectedFrontendPort,
  hasEnvExampleOpensource,
  isHomeRepo,
  repoLabel,
} from './port-drift/context.mjs';
import { registerEnvTemplatePart1 } from './port-drift/env-template-1.mjs';
import { registerPublicDocsPart1 } from './port-drift/public-docs-1.mjs';
import { registerRoundTripPart1 } from './port-drift/round-trip-1.mjs';
import { registerSyncSafetyPart1 } from './port-drift/sync-safety-1.mjs';
import { registerSyncTransformPart1 } from './port-drift/sync-transform-1.mjs';
import { registerSyncTransformPart2 } from './port-drift/sync-transform-2.mjs';
import { registerSyncTransformPart3 } from './port-drift/sync-transform-3.mjs';
import { registerSyncTransformPart4 } from './port-drift/sync-transform-4.mjs';
import { registerSyncTransformPart5 } from './port-drift/sync-transform-5.mjs';
import { registerSyncTransformPart6 } from './port-drift/sync-transform-6.mjs';
import { registerSyncValidationPart1 } from './port-drift/sync-validation-1.mjs';

describe('PR1398 round-trip consumer parity', { skip: !isHomeRepo }, () => {
  registerRoundTripPart1();
});

describe(
  '.env.example.opensource port consistency',
  { skip: !hasEnvExampleOpensource && '.env.example.opensource not present (open-source repo uses .env.example)' },
  () => {
    registerEnvTemplatePart1();
  },
);

describe(`Code-side port defaults are internally consistent (${repoLabel}: API=${expectedApiPort}, Frontend=${expectedFrontendPort})`, () => {
  registerCodeDefaultsPart1();
});

describe(
  'Sync transform rules match convention',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    registerSyncTransformPart1();
    registerSyncTransformPart2();
    registerSyncTransformPart3();
    registerSyncTransformPart4();
    registerSyncTransformPart5();
    registerSyncTransformPart6();
  },
);

describe(
  'Sync validation enforces static quality gates',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    registerSyncValidationPart1();
  },
);

describe(
  'Sync runtime-safety guards stay source-side and shell-safe',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    registerSyncSafetyPart1();
  },
);

describe(
  'Public-facing skill docs avoid home-only API defaults',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    registerPublicDocsPart1();
  },
);
