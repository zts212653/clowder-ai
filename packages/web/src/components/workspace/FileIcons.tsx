const FILE_ICONS: Record<string, { color: string; label: string }> = {
  ts: { color: '#3178C6', label: 'TS' },
  tsx: { color: '#3178C6', label: 'TX' },
  js: { color: '#F7DF1E', label: 'JS' },
  jsx: { color: '#F7DF1E', label: 'JX' },
  json: { color: '#A8B686', label: '{}' },
  md: { color: '#848484', label: 'M' },
  css: { color: '#264DE4', label: 'C' },
  html: { color: '#E34C26', label: '<>' },
  yaml: { color: '#CB171E', label: 'Y' },
  yml: { color: '#CB171E', label: 'Y' },
  sh: { color: '#89E051', label: '$' },
  py: { color: '#3776AB', label: 'Py' },
  svg: { color: '#FFB13B', label: 'S' },
  png: { color: '#A66BBE', label: '~' },
  jpg: { color: '#A66BBE', label: '~' },
};

export function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icon = FILE_ICONS[ext];
  if (!icon) {
    return (
      <span className="w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center bg-gray-200 text-cafe-secondary flex-shrink-0">
        F
      </span>
    );
  }
  return (
    <span
      className="w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center flex-shrink-0 text-white"
      style={{ backgroundColor: icon.color }}
    >
      {icon.label}
    </span>
  );
}

export function DirIcon({ expanded }: { expanded: boolean }) {
  return (
    <span
      className={`w-4 h-4 flex items-center justify-center flex-shrink-0 transition-transform duration-150 ${expanded ? 'text-cocreator-primary' : 'text-cocreator-dark/60'}`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {expanded ? (
          <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v1.268a.5.5 0 0 0 .02.1l1.455 5.83A1.5 1.5 0 0 0 2.93 12H13.07a1.5 1.5 0 0 0 1.455-1.302l1.455-5.83a.5.5 0 0 0 .02-.1V3.5A1.5 1.5 0 0 0 14.5 2h-6a.5.5 0 0 1-.354-.146l-.854-.854A1.5 1.5 0 0 0 6.232 .5H1.5Z" />
        ) : (
          <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 1 9.828 3H13.5a2 2 0 0 1 2 2v.172l-8 1.635V14H2a2 2 0 0 1-2-2V4a1 1 0 0 1 .54-.87ZM14.28 7l-9.28 1.897V12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7h-.72Z" />
        )}
      </svg>
    </span>
  );
}
