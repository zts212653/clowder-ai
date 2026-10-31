import { fileURLToPath } from 'node:url';
// @ts-expect-error The credential-source policy is a plain Node ESM asset.
import * as sources from '../dist/runtime/scripts/lib/secret-credential-paths.mjs';
// @ts-expect-error The canonical shared boundary is a plain Node ESM asset.
import * as boundary from '../dist/runtime/scripts/lib/secret-tool-io.mjs';

export { inspectSecretValue } from '../dist/runtime/scripts/lib/secret-value-inspection.mjs';

export interface ExposureNotice {
  state: 'exposed_or_suspected';
  callId?: string;
  rules: string[];
}
export interface CredentialSources {
  files: string[];
  directories: string[];
}
export const credentialSourcesFromEnvironment = sources.credentialSourcesFromEnvironment as (
  environment: Record<string, string | undefined>,
  cwd?: string,
) => CredentialSources;
export const configuredCredentialValues = sources.configuredCredentialValues as (
  environment?: Record<string, string | undefined>,
) => string[];
export const withSecretToolGuard = boundary.withSecretToolGuard as (
  name: string,
  args: unknown,
  execute: (args: unknown) => Promise<unknown>,
  options: {
    callId: string;
    cwd: string;
    credentialSources?: CredentialSources;
    outbound?: boolean;
    knownCredentials?: string[];
    environment?: Record<string, string | undefined>;
    notify: (notice: ExposureNotice) => Promise<void>;
  },
) => Promise<unknown>;
export const isCredentialSource = sources.isCredentialSource as (
  path: string,
  cwd?: string,
  credentialSources?: CredentialSources,
) => boolean;

/** src and dist share the same package root; deployment never changes that coordinate. */
export function secretRuntimeRoot(): string {
  return fileURLToPath(new URL('../dist/runtime/', import.meta.url));
}
export function secretRuntimeScript(name: string): string {
  return fileURLToPath(new URL(`../dist/runtime/scripts/${name}`, import.meta.url));
}
