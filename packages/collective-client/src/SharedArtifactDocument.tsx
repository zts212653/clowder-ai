import { useEffect, useRef, useState } from 'react';
import type { SharedMarkdownView } from './collective-artifact-client.js';
import { useCollectiveText } from './collective-copy.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { sharedMarkdownDomSelection } from './shared-markdown-selection.js';

/** Selection is only a composer attachment. Neither mouseup nor the chip sends a message. */
export function SharedArtifactDocument({ view }: { readonly view: SharedMarkdownView }) {
  const t = useCollectiveText();
  const paper = useRef<HTMLDivElement>(null);
  const reading = useSharedArtifactReading();
  const [notice, setNotice] = useState<string>();
  const version = `${view.contentRef}:${view.ownerRevision}:${view.blobDigest}`;
  const currentVersion = useRef(version);
  currentVersion.current = version;
  useEffect(() => {
    let active = true;
    const select = async (event: Event) => {
      if (!paper.current || !view.view.canWrite) return;
      const span = sharedMarkdownDomSelection(paper.current, event, view.text);
      if (span === undefined) return;
      if (!span || span.end - span.start > 8000) {
        setNotice('这处选文无法准确定位，请缩小选区再试。');
        return;
      }
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(view.text.slice(span.start, span.end))),
      );
      if (!active || currentVersion.current !== version || !reading?.artifact) return;
      reading.setQuote({
        artifactId: reading.artifact.artifactId,
        ownerRevision: view.ownerRevision,
        blobDigest: view.blobDigest,
        span: {
          ...span,
          quoteDigest: `sha256:${Array.from(hash, (item) => item.toString(16).padStart(2, '0')).join('')}`,
        },
      });
      setNotice(undefined);
    };
    document.addEventListener('pointerup', select);
    document.addEventListener('keyup', select);
    return () => {
      active = false;
      document.removeEventListener('pointerup', select);
      document.removeEventListener('keyup', select);
    };
  }, [reading?.artifact, reading?.setQuote, version, view]);
  return (
    <>
      <div ref={paper} className="shared-artifact-document">
        <MessageMarkdown source={view.text} sourceCoordinates />
      </div>
      {notice && <output className="composer-warning">{t(notice)}</output>}
    </>
  );
}
