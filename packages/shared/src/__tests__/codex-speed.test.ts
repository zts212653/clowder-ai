import { describe, expect, it } from 'vitest';
import {
  CODEX_SPEED_VALUES,
  isCodexSpeedValue,
  resolveCodexSpeed,
  resolveCodexSpeedWire,
  supportsCodexFastModel,
} from '../codex-speed.js';

describe('F291 Codex speed contract', () => {
  it('keeps the persisted semantic vocabulary smaller than provider wire values', () => {
    expect(CODEX_SPEED_VALUES).toEqual(['standard', 'fast']);
    expect(isCodexSpeedValue('standard')).toBe(true);
    expect(isCodexSpeedValue('fast')).toBe(true);
    expect(isCodexSpeedValue('inherit')).toBe(false);
    expect(isCodexSpeedValue('default')).toBe(false);
    expect(isCodexSpeedValue('priority')).toBe(false);
  });

  it.each([
    ['gpt-5.4', true],
    ['gpt-5.5', true],
    ['gpt-5.6-sol', true],
    ['gpt-5.6-terra', true],
    ['openai/gpt-5.6-sol', true],
    ['gpt-5.3-codex', false],
    ['gpt-6', false],
    ['', false],
  ])('classifies the v1 Fast model family %s', (model, expected) => {
    expect(supportsCodexFastModel(model)).toBe(expected);
  });

  it('resolves thread override before the member default', () => {
    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'oauth',
        model: 'gpt-5.6-sol',
        memberDefault: 'fast',
        threadOverride: 'standard',
      }),
    ).toEqual({
      configurable: true,
      options: ['standard', 'fast'],
      override: 'standard',
      inherited: 'fast',
      requested: 'standard',
      source: 'thread_override',
      compatibility: 'compatible',
    });
  });

  it('falls through from member default to the Codex user config', () => {
    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'oauth',
        model: 'gpt-5.6-terra',
        memberDefault: 'fast',
      }),
    ).toMatchObject({ requested: 'fast', source: 'member_default', compatibility: 'compatible' });

    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'oauth',
        model: 'gpt-5.6-terra',
      }),
    ).toMatchObject({ requested: null, source: 'codex_default', compatibility: 'compatible' });
  });

  it('keeps raw intent but suppresses it for non-OAuth and unsupported models', () => {
    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'api_key',
        model: 'gpt-5.6-sol',
        memberDefault: 'fast',
        threadOverride: 'standard',
      }),
    ).toEqual({
      configurable: false,
      options: [],
      override: 'standard',
      inherited: 'fast',
      requested: null,
      source: 'thread_override',
      compatibility: 'incompatible',
    });

    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'oauth',
        model: 'gpt-5.3-codex',
        memberDefault: 'fast',
      }),
    ).toEqual({
      configurable: true,
      options: ['standard'],
      override: null,
      inherited: 'fast',
      requested: null,
      source: 'member_default',
      compatibility: 'incompatible',
    });
  });

  it('allows Standard even when Fast is unavailable', () => {
    expect(
      resolveCodexSpeed({
        clientId: 'openai',
        authType: 'oauth',
        model: 'gpt-5.3-codex',
        threadOverride: 'standard',
      }),
    ).toMatchObject({ requested: 'standard', compatibility: 'compatible', options: ['standard'] });
  });

  it('projects semantic intent into carrier-specific three-state wires', () => {
    expect(resolveCodexSpeedWire(undefined)).toEqual({ kind: 'inherit' });
    expect(resolveCodexSpeedWire('standard')).toEqual({ kind: 'standard' });
    expect(resolveCodexSpeedWire('fast')).toEqual({ kind: 'fast', request: 'fast' });
  });
});
