import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelMessage } from '../ChannelMessage.js';
import type { CollectiveEventEnvelope } from '../client-types.js';
import { hostAppearance, startHostAppearance } from '../host-appearance.js';
import { TopicMessage } from '../TopicMessage.js';
import { resolveRoomPresentation } from '../use-room-presentation.js';

/**
 * F322 B — which presentation the room draws, now that a host can say. Precedence: an explicit prop (tests, previews) beats
 * a valid host, which beats the frame URL (`?presentation=v2|classic`, a link and acceptance entry), which beats the default,
 * classic. The host is the Café that opened the room; the room has no switch of its own.
 */
const HOST = 'https://cafe.example.test';
const ME = 'human_12345678';
const mine = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  eventId: 'evt_mine',
  clientEventId: 'evt_mine',
  sequence: 1,
  actor: { kind: 'human', humanId: ME, displayName: '阿宪' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '三版封面，暖一点。',
  acceptedAt: '2026-10-01T10:01:00.000Z',
} as unknown as CollectiveEventEnvelope;

describe('resolving the presentation', () => {
  it('lets an explicit choice beat the host, the host beat the URL, and the URL beat the default', () => {
    expect(resolveRoomPresentation({ explicit: 'classic', host: 'v2', search: '?presentation=v2' })).toBe('classic');
    expect(resolveRoomPresentation({ explicit: undefined, host: 'classic', search: '?presentation=v2' })).toBe(
      'classic',
    );
    expect(resolveRoomPresentation({ explicit: undefined, host: 'v2', search: '?presentation=classic' })).toBe('v2');
    expect(resolveRoomPresentation({ explicit: undefined, host: undefined, search: '?presentation=v2' })).toBe('v2');
    expect(resolveRoomPresentation({ explicit: undefined, host: undefined, search: '' })).toBe('classic');
    expect(resolveRoomPresentation({ explicit: undefined, host: undefined, search: '?presentation=auto' })).toBe(
      'classic',
    );
  });
});

describe('the room follows the host that opened it', () => {
  const parent = {};
  const fakeWindow = {
    location: { search: `?hostOrigin=${encodeURIComponent(HOST)}` },
    parent,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Window;
  const fakeRoot = {
    setAttribute: () => undefined,
    style: { setProperty: () => undefined, removeProperty: () => undefined },
  } as unknown as HTMLElement;
  const roles = {
    canvas: '#fbf7f2',
    surface: '#f6efe7',
    sunken: '#ece3d9',
    text: '#2a211b',
    textMuted: '#6c5f55',
    accent: '#7a5a43',
    humanPrimary: '#8c6f5a',
    humanSurface: '#e3d2c3',
    humanName: '#2c1f1f',
  };
  const say = (presentation: 'classic' | 'v2', revision: number) =>
    hostAppearance().receive({
      origin: HOST,
      source: parent,
      data: {
        type: 'collective:host-appearance',
        v: 1,
        bridgeId: 'bridge_aaaaaaaa',
        appearanceRevision: revision,
        presentation,
        resolvedScheme: 'light',
        roles,
      },
    });
  const channel = () =>
    renderToStaticMarkup(
      <ChannelMessage
        thread={{ root: mine, replies: [] }}
        currentHumanId={ME}
        onOpenTopic={() => undefined}
        onMention={() => undefined}
        onOpenMember={() => undefined}
      />,
    );
  const topic = () => renderToStaticMarkup(<TopicMessage event={mine} currentHumanId={ME} />);

  beforeEach(() => {
    startHostAppearance(fakeWindow, fakeRoot);
    hostAppearance().observeGeneration('bridge_aaaaaaaa');
  });
  afterEach(() => hostAppearance().dispose());

  it('draws the old layout while the host has said nothing', () => {
    expect(channel()).not.toContain('data-author');
    expect(topic()).not.toContain('data-author');
  });

  it('draws the new presentation when the host says v2, and the old one when it says classic', () => {
    expect(say('v2', 1)).toBe(true);
    expect(channel()).toContain('data-author="self"');
    expect(topic()).toContain('data-author="self"');

    expect(say('classic', 2)).toBe(true);
    expect(channel()).not.toContain('data-author');
    expect(topic()).not.toContain('data-author');
  });

  it('keeps what the host said across a new generation, and takes the new generation from revision 1', () => {
    say('v2', 1);
    hostAppearance().observeGeneration('bridge_bbbbbbbb');
    expect(channel()).toContain('data-author="self"');

    expect(say('classic', 2)).toBe(false);
    expect(
      hostAppearance().receive({
        origin: HOST,
        source: parent,
        data: {
          type: 'collective:host-appearance',
          v: 1,
          bridgeId: 'bridge_bbbbbbbb',
          appearanceRevision: 1,
          presentation: 'classic',
          resolvedScheme: 'light',
          roles,
        },
      }),
    ).toBe(true);
    expect(channel()).not.toContain('data-author');
  });
});
