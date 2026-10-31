/**
 * F174 D2b-1 cloud Codex P2 #1397 regression — RichBlocks dispatcher MUST
 * route to CallbackAuthFailureBlock only when the message comes from a
 * trusted source (`source.connector === 'callback-auth'`). Otherwise a
 * regular cat/user card with `meta.kind === 'callback_auth_failure'` would
 * spoof the system warning UI and the hide-similar action.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichBlocks } from '../RichBlocks';

Object.assign(globalThis as Record<string, unknown>, { React });

const callbackAuthBlock = {
  id: 'b1',
  kind: 'card' as const,
  v: 1 as const,
  title: 'Callback Auth Failure',
  bodyMarkdown: 'register_pr_tracking failed: token expired',
  tone: 'warning' as const,
  meta: {
    kind: 'callback_auth_failure',
    reason: 'expired',
    tool: 'register_pr_tracking',
    catId: 'opus',
    threadId: 't1',
    userId: 'u1',
    failedAt: 1700000000000,
    fallbackOk: false,
  },
};

describe('RichBlocks dispatcher — trusted-provenance gate (F174 D2b-1 cloud P2)', () => {
  it('renders CallbackAuthFailureBlock when source.connector === "callback-auth"', () => {
    const html = renderToStaticMarkup(
      <RichBlocks
        blocks={[callbackAuthBlock]}
        messageSource={{ connector: 'callback-auth', label: 'Callback Auth', icon: '🔌' }}
      />,
    );
    // CallbackAuthFailureBlock-specific markers
    expect(html).toContain('CALLBACK AUTH FAILURE');
    expect(html).toContain('隐藏类似消息');
  });

  it('falls through to default CardBlock when messageSource is undefined (untrusted)', () => {
    // Defense against spoofed meta from untrusted card sources (regular cat output).
    const html = renderToStaticMarkup(<RichBlocks blocks={[callbackAuthBlock]} />);
    expect(html).not.toContain('CALLBACK AUTH FAILURE'); // CallbackAuthFailureBlock not used
    expect(html).not.toContain('隐藏类似消息');
    expect(html).toContain('Callback Auth Failure'); // CardBlock title (lowercase a)
  });

  it('falls through to default CardBlock when source.connector is some OTHER connector', () => {
    const html = renderToStaticMarkup(
      <RichBlocks
        blocks={[callbackAuthBlock]}
        messageSource={{ connector: 'vote-result', label: 'Vote', icon: 'ballot' }}
      />,
    );
    expect(html).not.toContain('CALLBACK AUTH FAILURE');
    expect(html).not.toContain('隐藏类似消息');
  });

  it('falls through to default CardBlock when meta.kind is missing (cat-authored card with no spoof)', () => {
    const plainBlock = { ...callbackAuthBlock, meta: undefined };
    const html = renderToStaticMarkup(
      <RichBlocks
        blocks={[plainBlock]}
        messageSource={{ connector: 'callback-auth', label: 'Callback Auth', icon: '🔌' }}
      />,
    );
    expect(html).not.toContain('CALLBACK AUTH FAILURE');
  });
});
