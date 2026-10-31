import { forwardRef } from 'react';

/** Opaque embedded HTML receives no forms, top navigation or microphone authority. */
export const SandboxedWidgetFrame = forwardRef<
  HTMLIFrameElement,
  {
    id?: string;
    html: string;
    title: string;
    height: number;
    scrolling?: 'yes' | 'no' | 'auto';
  }
>(function SandboxedWidgetFrame({ id, html, title, height, scrolling = 'no' }, ref) {
  return (
    <iframe
      id={id}
      ref={ref}
      srcDoc={html}
      sandbox="allow-scripts"
      scrolling={scrolling}
      title={title}
      style={{ width: '100%', height: `${height}px`, border: 'none', display: 'block' }}
      referrerPolicy="no-referrer"
    />
  );
});
