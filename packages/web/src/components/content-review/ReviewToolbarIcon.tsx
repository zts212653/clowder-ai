const paths = {
  view: 'M9 5 2 12l7 7M2 12h19',
  markup: 'M3 17c5-2 9-12 12-12 4 0-8 14-4 14 2 0 6-7 8-7 2 0-1 5 2 5',
  comment: 'M20 15a3 3 0 0 1-3 3H9l-5 3v-5a7 7 0 0 1-2-5V9a7 7 0 0 1 7-7h5a7 7 0 0 1 7 7v2M10 7v7m-3.5-3.5h7',
  select: 'm4 3 15 9-7 2-3 7-5-18Z',
  brush: 'm14 4 6 6M4 20l5-1L21 7a2.1 2.1 0 0 0-3-3L6 16l-2 4Z',
  rectangle: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
  ellipse: 'M21 12a9 7 0 1 1-18 0 9 7 0 1 1 18 0Z',
  arrow: 'M4 20 20 4M7 4h13v13',
  text: 'M4 6V3h16v3M12 3v18m-4 0h8',
  eraser: 'm9 20-6-6a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-9 9H9Zm-3-12 9 9m-6 3h13',
  undo: 'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12',
  redo: 'm16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
  close: 'm6 6 12 12M6 18 18 6',
  send: 'M12 20V4m-7 7 7-7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  history: 'M3 10a9 9 0 1 1 1 7M3 4v6h6m3-4v6l4 3',
  refresh: 'M3 10a9 9 0 0 1 15-5l3 3M21 3v5h-5M21 14a9 9 0 0 1-15 5l-3-3m0 5v-5h5',
  check: 'm5 12 4 4L19 6',
  resize: 'M8 3H3v5m13 13h5v-5M3 3l6 6m6 6 6 6M14 3h5a2 2 0 0 1 2 2v6M3 13v6a2 2 0 0 0 2 2h6',
} as const;

export type ReviewIconName = keyof typeof paths;

export function ReviewToolbarIcon({ name }: { name: ReviewIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
