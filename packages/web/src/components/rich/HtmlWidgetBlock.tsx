'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { addHtmlWidgetHeightBridge } from './html-widget-height-bridge';
import {
  createInitialWidgetLayoutState,
  isValidWidgetProofRequestId,
  readWidgetHeightMessage,
  reduceWidgetLayout,
  WIDGET_PROOF_REQUEST_EVENT,
  WIDGET_PROOF_REQUEST_MESSAGE,
} from './html-widget-layout-machine';
import { resolveWidgetMeasurementError, resolveWidgetPresentation } from './html-widget-presentation';
import { sanitizeWidgetHtml } from './sanitize-widget-html';

function isExportSearch(search: string): boolean {
  const value = new URLSearchParams(search).get('export');
  return value === 'true' || value === '1';
}

function subscribeToLocation(): () => void {
  return () => {};
}

function readExportMode(): boolean {
  return typeof window !== 'undefined' && isExportSearch(window.location.search);
}

export function HtmlWidgetBlock({ block }: { block: RichHtmlWidgetBlock }) {
  const reactId = useId();
  const instanceId = `html-widget-${reactId}`;
  const iframeId = `${instanceId}-frame`;
  const accessibleTitle = block.title ?? 'Interactive Widget';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const requestedProofIdRef = useRef<string | null>(null);
  const [layout, setLayout] = useState(createInitialWidgetLayoutState);
  const [acknowledgedProofId, setAcknowledgedProofId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const isExport = useSyncExternalStore(subscribeToLocation, readExportMode, () => false);
  const safeHtml = useMemo(() => (browserReady ? sanitizeWidgetHtml(block.html) : null), [block.html, browserReady]);
  const bridgedHtml = useMemo(
    () => (safeHtml === null ? null : addHtmlWidgetHeightBridge(safeHtml, block.id, instanceId)),
    [block.id, instanceId, safeHtml],
  );

  useEffect(() => setBrowserReady(true), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: block identity/content changes must reset measured child state
  useEffect(() => {
    setLayout(createInitialWidgetLayoutState());
    requestedProofIdRef.current = null;
    setAcknowledgedProofId(null);
    setExpanded(false);
  }, [block.html, block.id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const result = readWidgetHeightMessage(event, {
        source: iframeRef.current?.contentWindow ?? null,
        blockId: block.id,
        instanceId,
      });
      if (result.status === 'ignored') return;
      if (result.status === 'pending') {
        if (result.cause === 'content') setAcknowledgedProofId(null);
        setLayout((previous) => reduceWidgetLayout(previous, { type: 'pending', cause: result.cause }, isExport));
        return;
      }
      if (result.status === 'invalid') {
        setAcknowledgedProofId(null);
        setLayout((previous) => reduceWidgetLayout(previous, { type: 'invalid' }, isExport));
        return;
      }
      setLayout((previous) => reduceWidgetLayout(previous, { type: 'measured', sample: result.sample }, isExport));
      if (result.proofRequestId === requestedProofIdRef.current) {
        requestedProofIdRef.current = null;
        setAcknowledgedProofId(result.proofRequestId);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [block.id, instanceId, isExport]);

  useEffect(() => {
    if (!isExport) return;
    const onProofRequest = (event: Event) => {
      const proofRequestId = (event as CustomEvent<unknown>).detail;
      if (!isValidWidgetProofRequestId(proofRequestId)) return;
      const childWindow = iframeRef.current?.contentWindow;
      if (!childWindow) return;
      requestedProofIdRef.current = proofRequestId;
      setAcknowledgedProofId(null);
      childWindow.postMessage(
        {
          type: WIDGET_PROOF_REQUEST_MESSAGE,
          v: 6,
          blockId: block.id,
          instanceId,
          proofRequestId,
        },
        '*',
      );
    };
    window.addEventListener(WIDGET_PROOF_REQUEST_EVENT, onProofRequest);
    return () => window.removeEventListener(WIDGET_PROOF_REQUEST_EVENT, onProofRequest);
  }, [block.id, instanceId, isExport]);

  const measuredHeight = layout.acceptedHeight;
  const measurementError = resolveWidgetMeasurementError(layout.error);

  const { fullyExpanded, longContent, visibleHeight } = resolveWidgetPresentation({
    block,
    expanded,
    isExport,
    measuredHeight,
  });

  useEffect(() => {
    if (visibleHeight > 0) window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
  }, [visibleHeight]);

  return (
    <div
      className="overflow-hidden rounded-lg border border-cafe"
      data-html-widget={block.id}
      data-html-widget-instance-id={instanceId}
      data-html-widget-layout-state={layout.phase}
      data-html-widget-expanded={fullyExpanded ? 'true' : 'false'}
      data-html-widget-proof-request-id={acknowledgedProofId ?? undefined}
      {...(measuredHeight === null ? {} : { 'data-html-widget-measured-height': String(measuredHeight) })}
    >
      {block.title && (
        <div className="border-b border-cafe bg-cafe-surface-elevated px-3 py-1.5 text-xs font-medium text-cafe-secondary">
          {block.title}
        </div>
      )}
      <div className="relative">
        {bridgedHtml === null ? (
          <output
            data-html-widget-loading
            aria-label={accessibleTitle}
            className="grid place-items-center bg-cafe-surface px-4 text-xs text-cafe-secondary"
            style={{ width: '100%', height: `${visibleHeight}px` }}
          >
            正在准备完整内容…
          </output>
        ) : (
          <iframe
            id={iframeId}
            ref={iframeRef}
            srcDoc={bridgedHtml}
            sandbox="allow-scripts"
            scrolling="no"
            title={accessibleTitle}
            style={{ width: '100%', height: `${visibleHeight}px`, border: 'none', display: 'block' }}
            referrerPolicy="no-referrer"
          />
        )}
        {longContent && !fullyExpanded ? (
          <div
            data-testid="html-widget-overflow-fade"
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-cafe-surface"
          />
        ) : null}
      </div>
      {measurementError ? (
        <p role="alert" className="border-t border-cafe px-3 py-2 text-xs text-cafe-warning">
          {measurementError}
        </p>
      ) : null}
      {longContent && !isExport ? (
        <div className="flex justify-center border-t border-cafe bg-cafe-surface px-3 py-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={iframeId}
            onClick={() => setExpanded((value) => !value)}
            className="rounded-md px-3 py-1.5 text-xs font-semibold text-cafe-accent transition-colors hover:bg-cafe-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
          >
            {expanded ? '收起完整内容' : '展开完整内容'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
