// @vitest-environment node
/**
 * F159 G2 regression: UnifiedAuthModal must always send clientId + clientFamily
 * in the API-key create/edit payload — even when initialClientId is absent
 * (the normal HubAccountsTab path). Previously, clientFamily was only sent
 * when initialClientId was provided (the wizard/ConfigStep path), so Hub-created
 * API-key accounts silently skipped the family guard.
 *
 * Also: the Client selector must be rendered in both OAuth and API-key modes
 * so the user can declare the API-key family.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../UnifiedAuthModal.tsx'), 'utf-8');

describe('UnifiedAuthModal clientFamily payload (F159 G2)', () => {
  // ── API-key create ──

  it('API-key POST sends clientId unconditionally (not gated by initialClientId)', () => {
    // The api_key create branch is the `else {` after `else if (isOAuth)`.
    // Find the api_key POST body and verify clientId uses fallback, not conditional.
    const apiKeyCreateIdx = source.indexOf("authType: 'api_key',");
    expect(apiKeyCreateIdx).toBeGreaterThan(0);

    // The clientId line after authType should use `initialClientId ?? clientId`, not be inside
    // a conditional `...(initialClientId ? { ... } : {})` pattern.
    const bodySlice = source.slice(apiKeyCreateIdx, apiKeyCreateIdx + 400);
    expect(bodySlice).toContain('clientId: initialClientId ?? clientId');
    // Must NOT contain the old conditional pattern
    expect(bodySlice).not.toContain('initialClientId ? { clientId:');
  });

  it('API-key POST sends clientFamily unconditionally alongside clientId', () => {
    const apiKeyCreateIdx = source.indexOf("authType: 'api_key',");
    const bodySlice = source.slice(apiKeyCreateIdx, apiKeyCreateIdx + 400);
    expect(bodySlice).toContain('clientFamily: initialClientId ?? clientId');
  });

  // ── PATCH (edit) ──

  it('PATCH guards clientId to preserve legacy untyped accounts (e.g. Kimi)', () => {
    // The PATCH branch starts with `if (isEdit) {`
    const patchIdx = source.indexOf('if (isEdit) {');
    expect(patchIdx).toBeGreaterThan(0);
    const patchSlice = source.slice(patchIdx, patchIdx + 1000);

    // Must contain guarded `patch.clientId = clientId` (inside hadClientId || userChangedClient)
    expect(patchSlice).toContain('patch.clientId = clientId');
    // Must guard against clobbering legacy untyped accounts
    expect(patchSlice).toContain('hadClientId');
    expect(patchSlice).toContain('editProfile?.clientId != null');
  });

  it('PATCH sends clientFamily for valid family values', () => {
    const patchIdx = source.indexOf('if (isEdit) {');
    const patchSlice = source.slice(patchIdx, patchIdx + 1200);
    expect(patchSlice).toContain('patch.clientFamily = clientId');
  });

  it('PATCH guards both clientId and clientFamily to preserve legacy untyped accounts', () => {
    // Legacy API-key accounts (no clientId, no clientFamily) — e.g. Kimi/Moonshot —
    // rely on name-based heuristics. A no-op edit must NOT stamp either field.
    // Only send clientId/clientFamily when the profile already had the field
    // OR the user explicitly changed the client selector.
    const patchIdx = source.indexOf('if (isEdit) {');
    const patchSlice = source.slice(patchIdx, patchIdx + 1200);
    // Must contain the guard checking for existing clientFamily
    expect(patchSlice).toContain('hadClientFamily');
    expect(patchSlice).toContain('userChangedClient');
    // Must reference editProfile?.clientFamily for the guard
    expect(patchSlice).toContain('editProfile?.clientFamily != null');
  });

  // ── Client selector visibility ──

  it('Client selector is rendered in both OAuth and API-key modes', () => {
    // The old code had `{isOAuth && (` wrapping the Client dropdown.
    // The new code renders it unconditionally (not gated by isOAuth).
    // Verify by checking the comment/label:
    expect(source).toContain('Client selector — shown in both OAuth and API-key modes');

    // The dropdown should use API_KEY_CLIENT_OPTIONS in API-key mode (excludes acp)
    expect(source).toContain('isOAuth ? CLIENT_OPTIONS : API_KEY_CLIENT_OPTIONS');
  });

  it('API-key mode Client dropdown excludes acp (OAuth-only protocol)', () => {
    expect(source).toContain(
      "const API_KEY_CLIENT_OPTIONS: BuiltinAccountClient[] = ['anthropic', 'openai', 'google', 'kimi', 'opencode']",
    );
    // acp must NOT be in the API_KEY_CLIENT_OPTIONS array
    const apiKeyOptionsLine = source.match(/const API_KEY_CLIENT_OPTIONS.*?;/s)?.[0] ?? '';
    expect(apiKeyOptionsLine).not.toContain('acp');
  });

  // ── clientFamily fallback for edits ──

  it('defaultClientId prefers clientFamily for API-key edits (F159 AC-G21)', () => {
    // API-key accounts must prefer the authoritative clientFamily over legacy
    // clientId to prevent silent family rewrite on no-op edits.
    expect(source).toContain("editProfile?.authType === 'api_key' ? editProfile?.clientFamily : undefined");
    // Non-API-key profiles still fall back through clientId → clientFamily → initialClientId
    expect(source).toContain('editProfile?.clientId');
    expect(source).toContain('editProfile?.clientFamily');
  });

  it('UnifiedAuthEditData includes clientFamily field', () => {
    expect(source).toContain('clientFamily?: BuiltinAccountClient');
  });
});

// ── HubAccountsTab passes clientFamily to edit data ──

const hubSource = readFileSync(resolve(__dirname, '../HubAccountsTab.tsx'), 'utf-8');

describe('HubAccountsTab clientFamily plumbing', () => {
  it('handleEdit passes clientFamily from profile to edit data', () => {
    expect(hubSource).toContain('clientFamily: profile.clientFamily');
  });
});
