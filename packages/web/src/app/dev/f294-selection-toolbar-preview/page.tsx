'use client';

import { useRef, useState } from 'react';
import { MessageActions } from '@/components/MessageActions';
import { MessageBundleItemView } from '@/components/MessageBundleItemView';
import { MessageSelectionToolbar } from '@/components/MessageSelectionToolbar';
import { RuntimeUpdateRequiredDialog } from '@/components/RuntimeUpdateRequiredDialog';
import { RichBlocks } from '@/components/rich/RichBlocks';
import { TransferTargetPickerView } from '@/components/TransferTargetPickerView';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';

const PICKER_CATS = Array.from({ length: 16 }, (_, index) => ({
  id: `fixture-cat-${index + 1}`,
  displayName: `布局测试猫 ${index + 1}`,
}));

function RuntimeDeploymentProbeFixture({ onReload }: { onReload: () => void }) {
  const connectionStatus = useConnectionStatus(null);
  const [note, setNote] = useState('');
  const [submitAttempts, setSubmitAttempts] = useState(0);
  const [multiSelectAttempts, setMultiSelectAttempts] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <section data-testid="f294-runtime-deployment-probe">
      <output data-testid="f294-runtime-submit-attempts">{submitAttempts}</output>
      <output data-testid="f294-runtime-multiselect-attempts">{multiSelectAttempts}</output>
      <MessageActions
        message={{
          id: 'f294-runtime-cli-source-message',
          type: 'assistant',
          catId: 'codex-sol',
          content: 'old document exact selected fragment',
          timestamp: 1_786_953_395_105,
          projectionSourceMessageIds: ['f294-runtime-cli-source-message'],
        }}
        threadId="f294-layout-preview"
        forwardingDisabled={connectionStatus.forwardingBlocked}
      >
        <div data-context-quote-source="cli_output">
          <span data-testid="f294-runtime-cli-source" data-context-quote-segment-id="runtime-stdout">
            old document exact selected fragment
          </span>
        </div>
      </MessageActions>
      <MessageSelectionToolbar
        threadId="f294-layout-preview"
        selectedMessageIds={['f294-runtime-cli-source-message']}
        forwardingDisabled={connectionStatus.forwardingBlocked}
        onCancel={() => {}}
        onExportSuccess={() => {}}
        onForward={() => setMultiSelectAttempts((attempts) => attempts + 1)}
      />
      {!connectionStatus.forwardingBlocked ? (
        <TransferTargetPickerView
          isDesktop={false}
          panelRef={panelRef}
          targetThreadId="fixture-target-thread"
          targetThreadTitle="旧页面转发目标"
          availableThreads={[]}
          cats={PICKER_CATS}
          targetCats={new Set(['fixture-cat-1'])}
          note={note}
          error={null}
          submitting={false}
          itemCount={1}
          singleItemLabel="1 段引用"
          onClose={() => {}}
          onBack={() => {}}
          onSelectThread={() => {}}
          onToggleCat={() => {}}
          onNoteChange={setNote}
          onSubmit={() => setSubmitAttempts((attempts) => attempts + 1)}
        />
      ) : null}
      {connectionStatus.updateRequired ? <RuntimeUpdateRequiredDialog onReload={onReload} /> : null}
    </section>
  );
}

export default function F294SelectionToolbarPreviewPage() {
  const [pickerSurface, setPickerSurface] = useState<'bottom-sheet' | 'modal' | null>(null);
  const [note, setNote] = useState('');
  const [showRuntimeProbe, setShowRuntimeProbe] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const pickerPanelRef = useRef<HTMLDivElement>(null);

  return (
    <main className="min-h-screen overflow-hidden bg-cafe-surface" data-testid="f294-selection-toolbar-preview">
      <div className="flex min-h-screen w-full flex-col" data-testid="chat-canvas">
        <div className="space-y-4 p-4">
          <section data-testid="f294-rich-source">
            <RichBlocks
              messageId="f294-rich-source-message"
              sourceThreadId="f294-layout-preview"
              sourceMessageIds={['f294-rich-stream', 'f294-rich-source-message']}
              blocks={[
                {
                  id: 'decision-card',
                  kind: 'card',
                  v: 1,
                  title: '决策摘要',
                  bodyMarkdown: '只转发这一块，不携带同一轮其他工作态。',
                },
              ]}
            />
          </section>
          <section data-testid="f294-rich-group-source">
            <RichBlocks
              messageId="f294-rich-group-source-message"
              sourceThreadId="f294-layout-preview"
              sourceMessageIds={['f294-rich-group-stream', 'f294-rich-group-source-message']}
              blocks={[
                {
                  id: 'group-choice-primary',
                  kind: 'interactive',
                  v: 1,
                  interactiveType: 'select',
                  title: '这是一条足够长的分组交互卡标题，用来证明转发动作不会遮住可读内容',
                  options: [{ id: 'keep-primary', label: '保留首张卡的选项' }],
                },
                {
                  id: 'group-choice-secondary',
                  kind: 'interactive',
                  v: 1,
                  interactiveType: 'select',
                  title: '第二张分组交互卡',
                  options: [{ id: 'keep-secondary', label: '保留第二张卡的选项' }],
                },
              ]}
            />
          </section>
          <section data-testid="f294-rich-target">
            <RichBlocks
              readOnly
              blocks={[
                {
                  id: 'interactive-copy',
                  kind: 'interactive',
                  v: 1,
                  interactiveType: 'select',
                  title: '接收侧只读副本',
                  options: [{ id: 'run', label: '不会触发原回调' }],
                },
                {
                  id: 'html-copy',
                  kind: 'html_widget',
                  v: 1,
                  title: '不执行 HTML',
                  html: '<script>globalThis.__f294Unsafe = true</script>',
                },
              ]}
            />
          </section>
          <MessageActions
            message={{
              id: 'f294-cli-source-message',
              type: 'assistant',
              catId: 'codex-sol',
              content: 'neighboring execution detail · exact selected fragment · neighboring secret',
              timestamp: 1_786_841_841_409,
              projectionSourceMessageIds: ['f294-cli-source-message'],
            }}
            threadId="f294-layout-preview"
          >
            <section
              className="rounded-lg border border-cafe p-3"
              data-testid="f294-cli-source"
              data-context-quote-source="cli_output"
            >
              <div className="text-xs font-semibold text-cafe-muted">CLI Output</div>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-cafe-primary">
                <span data-context-quote-segment-id="stdout">
                  neighboring execution detail · exact selected fragment · neighboring secret
                </span>
              </pre>
            </section>
          </MessageActions>
          <section className="rounded-lg border border-cafe p-3" data-testid="f294-cli-target">
            <MessageBundleItemView
              item={{
                status: 'available',
                kind: 'cli_quote',
                messageId: 'f294-cli-source-message',
                sourceThreadId: 'f294-layout-preview',
                author: { kind: 'cat', catId: 'codex-sol' },
                timestamp: 1_786_841_841_409,
                readableContent: 'exact selected fragment',
              }}
              index={0}
              createdBy="landy"
              forwarderName="co-creator"
              getCatLabel={() => '小太阳·砚砚'}
              onJump={() => {}}
            />
          </section>
          <button
            type="button"
            data-testid="f294-transfer-picker-bottom-sheet"
            className="rounded-lg border border-cafe px-3 py-2 text-sm text-cafe-primary"
            onClick={() => setPickerSurface('bottom-sheet')}
          >
            打开窄屏转发布局测试
          </button>
          <button
            type="button"
            data-testid="f294-transfer-picker-modal"
            className="rounded-lg border border-cafe px-3 py-2 text-sm text-cafe-primary"
            onClick={() => setPickerSurface('modal')}
          >
            打开桌面转发布局测试
          </button>
          <button
            type="button"
            data-testid="f294-simulate-runtime-update"
            className="rounded-lg border border-cafe px-3 py-2 text-sm text-cafe-primary"
            onClick={() => setShowRuntimeProbe(true)}
          >
            模拟运行时部署更新
          </button>
          {reloadRequested ? <p data-testid="f294-reload-requested">已请求刷新</p> : null}
        </div>
        <div className="flex-1" />
        <MessageSelectionToolbar
          threadId="f294-layout-preview"
          selectedMessageIds={['message-1', 'message-2']}
          forwardingDisabled={false}
          onCancel={() => {}}
          onExportSuccess={() => {}}
          onForward={() => {}}
        />
        {pickerSurface ? (
          <TransferTargetPickerView
            isDesktop={pickerSurface === 'modal'}
            panelRef={pickerPanelRef}
            targetThreadId="fixture-target-thread"
            targetThreadTitle="布局测试目标"
            availableThreads={[]}
            cats={PICKER_CATS}
            targetCats={new Set(['fixture-cat-1'])}
            note={note}
            error="源引用已经变化，请重新划线后再转发"
            submitting={false}
            itemCount={1}
            singleItemLabel="1 段引用"
            onClose={() => setPickerSurface(null)}
            onBack={() => {}}
            onSelectThread={() => {}}
            onToggleCat={() => {}}
            onNoteChange={setNote}
            onSubmit={() => {}}
          />
        ) : null}
        {showRuntimeProbe ? (
          <RuntimeDeploymentProbeFixture
            onReload={() => {
              setReloadRequested(true);
              setShowRuntimeProbe(false);
            }}
          />
        ) : null}
      </div>
    </main>
  );
}
