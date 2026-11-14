import type { CatId } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInputMenus } from '@/components/ChatInputMenus';
import { ComposerRoutingPreview } from '@/components/ComposerRoutingPreview';
import { buildCatOptions } from '@/components/chat-input-options';
import { MessageDispatchAvatars } from '@/components/MessageDispatchAvatars';
import { PluginManagerDetailCard } from '@/components/settings/plugin-manager/PluginManagerDetailCard';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '@/components/settings/plugin-manager/plugin-manager-fixtures';
import { usePluginTargets } from '@/hooks/usePluginMentionTargets';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';

function Proof() {
  const { targets, knownTargets } = usePluginTargets();
  const target = knownTargets[0];
  const menuRef = useRef<HTMLDivElement>(null);
  const [inserted, setInserted] = useState('');
  const receipt = {
    id: 'receipt',
    type: 'system' as const,
    from: { kind: 'system' as const, service: 'plugin_delivery' },
    content: '插件已接收消息。',
    timestamp: 2,
    extra: { pluginAddressedReceipt: { inputMessageId: 'source', targetId: 'pi_dot', accepted: true } },
  };
  const source = {
    id: 'source',
    type: 'user' as const,
    from: { kind: 'user' as const, userId: 'owner' },
    content: '@dot hello',
    timestamp: 1,
    lifecycle: {
      kind: 'input' as const,
      orderKey: 'source',
      dispatchRefs: [{ targetId: 'pi_dot', statusMessageId: 'receipt', phase: 'settled' as const, dispatchedAt: 2 }],
    },
  };
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 text-cafe-secondary">
      <h1 className="text-lg font-semibold">对话中的插件</h1>
      <ComposerRoutingPreview
        preview={{
          status: 'ready',
          targetCats: targets.map((p) => p.id as CatId),
          reason: { kind: 'current_message_mentions' },
        }}
        onInsertMention={(option) => setInserted(option.insert)}
      />
      <div className="flex h-56 items-end">
        <div className="relative w-full">
          <ChatInputMenus
            catOptions={buildCatOptions([], targets)}
            showMentions
            selectedIdx={0}
            onSelectIdx={() => {}}
            onInsertMention={(option) => setInserted(option.insert)}
            menuRef={menuRef}
          />
        </div>
      </div>
      <output data-testid="inserted">{inserted}</output>
      <div>
        <p>@dot hello</p>
        <MessageDispatchAvatars
          inline
          message={source}
          timelineMessages={[source, receipt]}
          activeRuns={[]}
          getCatLabel={() => '成员'}
        />
      </div>
      {target && (
        <PluginManagerDetailCard
          locale="zh"
          plugin={{
            ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
            id: 'example.dot',
            packageName: 'example-dot',
            setupSteps: [],
            steps: [],
            testable: false,
            capabilities: [],
            docsUrl: undefined,
            displayName: 'Dot',
            description: '可在对话中接收明确 @ 的插件',
            icon: target.icon ?? 'blocks',
            pluginInstanceId: target.id,
            address: { alias: target.alias, revision: target.addressRevision },
            intent: target.enabled ? 'enabled' : 'disabled',
            contributions: [],
            configFields: [],
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
