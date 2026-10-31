import type { ClientId } from './types/cat.js';

export const CODEX_SPEED_VALUES = ['standard', 'fast'] as const;

export type CodexSpeedValue = (typeof CODEX_SPEED_VALUES)[number];
export type CodexSpeedSource = 'thread_override' | 'member_default' | 'codex_default';
export type CodexSpeedCompatibility = 'compatible' | 'incompatible';

export interface ResolveCodexSpeedInput {
  clientId: ClientId;
  authType?: 'oauth' | 'api_key' | null;
  model?: string | null;
  memberDefault?: CodexSpeedValue | null;
  threadOverride?: CodexSpeedValue | null;
}

export interface CodexSpeedResolution {
  configurable: boolean;
  options: readonly CodexSpeedValue[];
  override: CodexSpeedValue | null;
  inherited: CodexSpeedValue | null;
  requested: CodexSpeedValue | null;
  source: CodexSpeedSource;
  compatibility: CodexSpeedCompatibility;
}

export type CodexSpeedWire = { kind: 'inherit' } | { kind: 'standard' } | { kind: 'fast'; request: 'fast' };

export function isCodexSpeedValue(value: unknown): value is CodexSpeedValue {
  return typeof value === 'string' && (CODEX_SPEED_VALUES as readonly string[]).includes(value);
}

/**
 * F291 v1 model boundary from the Codex Fast product contract.
 * Keep this single helper as the only maintained model-family snapshot until
 * Clowder AI consumes app-server model/list serviceTiers directly.
 */
export function supportsCodexFastModel(model: string | null | undefined): boolean {
  const slug = model?.trim().toLowerCase().split('/').at(-1) ?? '';
  return /^gpt-5\.(?:4|5|6)(?:$|[-.])/.test(slug);
}

export function resolveCodexSpeed(input: ResolveCodexSpeedInput): CodexSpeedResolution {
  const configurable = input.clientId === 'openai' && input.authType === 'oauth';
  const options: readonly CodexSpeedValue[] = configurable
    ? supportsCodexFastModel(input.model)
      ? CODEX_SPEED_VALUES
      : ['standard']
    : [];
  const override = input.threadOverride ?? null;
  const inherited = input.memberDefault ?? null;
  const selected = override ?? inherited;
  const source: CodexSpeedSource = override ? 'thread_override' : inherited ? 'member_default' : 'codex_default';
  const compatible = selected === null || (configurable && options.includes(selected));

  return {
    configurable,
    options,
    override,
    inherited,
    requested: compatible ? selected : null,
    source,
    compatibility: compatible ? 'compatible' : 'incompatible',
  };
}

export function resolveCodexSpeedWire(value: CodexSpeedValue | null | undefined): CodexSpeedWire {
  if (value === 'standard') return { kind: 'standard' };
  if (value === 'fast') return { kind: 'fast', request: 'fast' };
  return { kind: 'inherit' };
}
