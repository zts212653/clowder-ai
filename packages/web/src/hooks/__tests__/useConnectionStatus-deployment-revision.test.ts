import { describe, expect, it } from 'vitest';
import { createDeploymentRevisionTracker, deriveDeploymentAdmission } from '../useConnectionStatus';

describe('deployment revision guard', () => {
  it('keeps a production document read-only until its embedded revision is verified', () => {
    const page = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(page.read()).toMatchObject({
      client: 'a'.repeat(40),
      observed: null,
      verified: false,
      updateRequired: false,
    });
  });

  it('rejects an old A bundle when its first successful health response already reports B', () => {
    const page = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(page.observe('b'.repeat(40), true)).toEqual({
      client: 'a'.repeat(40),
      observed: 'b'.repeat(40),
      verified: false,
      updateRequired: true,
    });
  });

  it('allows writes only after the server verifies the embedded revision', () => {
    const page = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(page.observe('a'.repeat(40), true)).toMatchObject({
      client: 'a'.repeat(40),
      observed: 'a'.repeat(40),
      verified: true,
      updateRequired: false,
    });
  });

  it('stays unverified — not mismatched — when the server reports no deployment revision', () => {
    // An absent revision is unknown, not unequal. Latching it into the reload
    // gate bricked every production page after a deploy that shipped no Web
    // stamp: each refresh re-fetched the same null and re-locked the document.
    const page = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(page.observe(null, true)).toMatchObject({ verified: false, updateRequired: false });
  });

  it('stays unverified when the bundle itself carries no revision to compare', () => {
    // A reload cannot teach this document a revision it was never built with,
    // so the reload gate would be a promise the page cannot keep.
    const page = createDeploymentRevisionTracker(null, true);
    expect(page.observe('a'.repeat(40), true)).toMatchObject({ verified: false, updateRequired: false });
  });

  it('recovers on its own once the server publishes the matching revision again', () => {
    const page = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(page.observe(null, true).verified).toBe(false);
    expect(page.observe('a'.repeat(40), true)).toMatchObject({ verified: true, updateRequired: false });
  });

  it('keeps the client revision across hook remounts while a full reload embeds the new revision', () => {
    const oldPage = createDeploymentRevisionTracker('a'.repeat(40), true);
    expect(oldPage.observe('b'.repeat(40), true).updateRequired).toBe(true);

    const reloadedPage = createDeploymentRevisionTracker('b'.repeat(40), true);
    expect(reloadedPage.observe('b'.repeat(40), true)).toMatchObject({ verified: true, updateRequired: false });
  });
});

describe('deployment admission blast radius', () => {
  const unverified = { client: 'a'.repeat(40), observed: null, verified: false, updateRequired: false };
  const compatible = { client: 'a'.repeat(40), observed: 'a'.repeat(40), verified: true, updateRequired: false };
  const mismatch = { client: 'a'.repeat(40), observed: 'b'.repeat(40), verified: false, updateRequired: true };

  it('closes forwarding but keeps the composer writable while unverified', () => {
    // F294 guards forwarding payloads; an unproven deployment must not take
    // plain sending down with it.
    expect(deriveDeploymentAdmission(unverified, false)).toEqual({
      composerReadonly: false,
      forwardingBlocked: true,
    });
  });

  it('opens everything only when client and server revisions match', () => {
    expect(deriveDeploymentAdmission(compatible, false)).toEqual({
      composerReadonly: false,
      forwardingBlocked: false,
    });
  });

  it('closes the composer too on a detected mismatch, where a reload really does recover', () => {
    expect(deriveDeploymentAdmission(mismatch, false)).toEqual({
      composerReadonly: true,
      forwardingBlocked: true,
    });
  });

  it('still closes both when connectivity is down, whatever the revision says', () => {
    expect(deriveDeploymentAdmission(compatible, true)).toEqual({
      composerReadonly: true,
      forwardingBlocked: true,
    });
  });
});
