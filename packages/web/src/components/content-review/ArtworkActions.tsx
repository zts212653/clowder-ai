import type { ComponentProps } from 'react';
import { useArtworkActionsVisible, useArtworkChrome } from './ArtworkChrome';
import { FileActions } from './FileActions';

type Props = Omit<ComponentProps<typeof FileActions>, 'source' | 'target' | 'contextRef' | 'visible' | 'workMode'> & {
  originalUrl: string;
};
/** Media contributes pixels/viewport controls; file operations have one implementation. */
export function ArtworkActions({ originalUrl, ...props }: Props) {
  const chrome = useArtworkChrome();
  const visible = useArtworkActionsVisible();
  if (!chrome?.actions) return null;
  return (
    <FileActions
      {...props}
      source={{ kind: 'url', url: originalUrl }}
      target={chrome.actions}
      contextRef={props.root}
      visible={visible}
      showDownload
      workMode={chrome.workMode}
      onHistory={props.onHistory ?? chrome.history}
    />
  );
}
