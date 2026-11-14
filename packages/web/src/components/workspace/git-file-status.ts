/** Git status letter → the badge both Changes panels (classic and V2) show for a file. F314 cluster 16. */
const statusLabels: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: 'text-amber-400' },
  A: { label: 'A', color: 'text-green-400' },
  D: { label: 'D', color: 'text-conn-red-text' },
  R: { label: 'R', color: 'text-blue-400' },
  '?': { label: 'U', color: 'text-cafe-muted' },
  '??': { label: 'U', color: 'text-cafe-muted' },
};

export function getStatusInfo(status: string): { label: string; color: string } {
  return statusLabels[status] ?? { label: status, color: 'text-cafe-muted' };
}
