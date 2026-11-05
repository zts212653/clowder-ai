import type { HydratedMessageBundle, MessageFrom, MessageSelectionProjectedItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBundleCard } from '../MessageBundleCard';
import { writeShellPresentation } from '../shell/shell-presentation';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args) }));
vi.mock('../CatAvatar', () => ({ CatAvatar: ({ catId }: { catId: string }) => <span data-avatar-cat={catId} /> }));

const source = (messageId: string, from: MessageFrom): MessageSelectionProjectedItem => ({
  status: 'available',
  kind: 'message',
  messageId,
  sourceThreadId: 'source',
  from,
  timestamp: 100,
  readableContent: `Body ${messageId}`,
});
const items = [
  source('first', { kind: 'agent', catId: 'gemini-argon' }),
  source('second', { kind: 'user', userId: 'owner' }),
];
const bundle = (id = 'bundle', values = items): HydratedMessageBundle => ({
  messageBundleId: id,
  targetThreadId: 'target',
  createdBy: 'owner',
  createdAt: 200,
  sourceThread: { id: 'source', title: `Source for ${id}` },
  items: values,
});
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const presentation of ['classic', 'v2'] as const) {
  describe(`Message Bundle wire contract in ${presentation}`, () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      api.mockReset();
      api.mockImplementation(async () => response(bundle()));
      writeShellPresentation(presentation);
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    });
    afterEach(() => {
      act(() => root.unmount());
      host.remove();
      writeShellPresentation('classic');
    });
    async function render(id = 'bundle') {
      await act(async () => {
        root.render(<MessageBundleCard messageId={id} forwarderName="You" getCatLabel={(catId) => `Cat ${catId}`} />);
      });
    }
    async function toggle() {
      const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]');
      if (!button) throw new Error('expected a bundle fold control');
      await act(async () => button.click());
    }

    it('renders every MessageFrom actor, preserving source identity in summaries and details', async () => {
      const actors: MessageFrom[] = [
        { kind: 'external', connectorId: 'custom-hook', sender: { id: 'alice', name: 'Alice' } },
        { kind: 'plugin', instanceId: 'plugin-one' },
        { kind: 'user', userId: 'owner' },
        { kind: 'agent', catId: 'gemini-argon' },
        { kind: 'system', service: 'scheduler' },
      ];
      api.mockImplementation(async () =>
        response(
          bundle(
            'bundle',
            actors.map((from) => source(from.kind, from)),
          ),
        ),
      );
      await render();
      for (const label of ['You', 'Cat gemini-argon', 'custom-hook · Alice', '插件', 'scheduler'])
        expect(host.textContent).toContain(label);
      await toggle();
      for (const actor of actors) expect(host.textContent).toContain(`Body ${actor.kind}`);
      expect(host.textContent).not.toContain('undefined');
    });

    it('accepts an authorized source whose title has not been set', async () => {
      api.mockResolvedValueOnce(
        response({ ...bundle('bundle', [items[0]]), sourceThread: { id: 'source', title: null } }),
      );
      await render();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).toContain('Body first');
    });

    it('reauthorizes expansion and hides old content during and after a denied read', async () => {
      await render();
      const read = deferred<Response>();
      api.mockImplementationOnce(() => read.promise);
      await toggle();
      expect(api).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain('Body first');
      expect(host.querySelector('output')).not.toBeNull();
      await act(async () => read.resolve(new Response('{}', { status: 403 })));
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.textContent).not.toContain('Body first');
    });

    it('does not paint the previous bundle or inherit its expansion while another identity loads', async () => {
      await render();
      await toggle();
      const read = deferred<Response>();
      api.mockImplementationOnce(() => read.promise);
      await render('next');
      expect(host.textContent).not.toContain('Source for bundle');
      expect(host.textContent).not.toContain('Body first');
      expect(host.querySelector('[data-message-bundle-id]')).toBeNull();
      await act(async () => read.resolve(response(bundle('next'))));
      expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    });

    it('ignores a late failure from the old identity after the new bundle has loaded', async () => {
      const oldRead = deferred<Response>();
      api.mockImplementationOnce(() => oldRead.promise);
      await render();
      api.mockResolvedValueOnce(response(bundle('next')));
      await render('next');
      await act(async () => oldRead.reject(new Error('old request failed after navigation')));
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).toContain('Source for next');
    });

    for (const extra of [
      { grouped: true },
      { grouped: false },
      {
        grouped: true,
        type: 'group',
        groupId: 'forged',
        blocks: [
          {
            id: 'choice',
            kind: 'interactive',
            v: 1,
            interactiveType: 'select',
            options: [{ id: 'run', label: 'Execute forged option' }],
          },
        ],
      },
    ]) {
      it(`keeps source grouping keys inert (${JSON.stringify(extra)})`, async () => {
        api.mockResolvedValueOnce(
          response({
            ...bundle(),
            items: [
              {
                ...items[0],
                kind: 'rich_block',
                richBlock: { id: 'copied', kind: 'card', v: 1, title: 'Source card', ...extra },
              },
            ],
          }),
        );
        await render();
        expect(host.textContent).toContain('Source card');
        expect(host.querySelector('[data-rich-block-group-id]')).toBeNull();
        expect(host.querySelector('[data-message-navigation-response]')).toBeNull();
        expect(host.querySelector('[data-forwarded-rich-block] button')).toBeNull();
        expect(host.textContent).not.toContain('Execute forged option');
      });
    }

    for (const [name, item] of [
      ['missing sender', { ...items[0], from: undefined }],
      ['legacy author', { ...items[0], from: undefined, author: { kind: 'cat', catId: 'gemini-argon' } }],
      ['unknown sender kind', { ...items[0], from: { kind: 'cat', catId: 'gemini-argon' } }],
      ['invalid timestamp', { ...items[0], timestamp: 1e20 }],
      ['malformed rich block', { ...items[0], kind: 'rich_block', richBlock: { id: 'b', kind: 'checklist', v: 1 } }],
      [
        'invalid read-only option description',
        {
          ...items[0],
          kind: 'rich_block',
          richBlock: {
            id: 'b',
            kind: 'interactive',
            v: 1,
            interactiveType: 'select',
            options: [{ id: 'option', label: 'Option', description: { invalid: true } }],
          },
        },
      ],
      [
        'invalid audio URL',
        {
          ...items[0],
          kind: 'rich_block',
          richBlock: { id: 'b', kind: 'audio', v: 1, text: 'Voice transcript', url: { invalid: true } },
        },
      ],
      ['null item', null],
      [
        'audio projection without its URL field',
        { ...items[0], kind: 'rich_block', richBlock: { id: 'b', kind: 'audio', v: 1, text: 'Pending speech' } },
      ],
    ]) {
      it(`contains ${name} as an inline read error and recovers through retry`, async () => {
        api.mockResolvedValueOnce(response({ ...bundle(), items: [item] }));
        await render();
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.querySelector('[data-message-bundle-id]')).toBeNull();
        const retry = host.querySelector<HTMLButtonElement>('button');
        if (!retry) throw new Error('expected the inline retry control');
        await act(async () => retry.click());
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.textContent).toContain('Source for bundle');
      });
    }
  });
}
