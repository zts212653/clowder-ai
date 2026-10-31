/** Product timestamps use the viewer's local zone and do not expose locale defaults. */
export function memoryTime(value: string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间没有记录下来';
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()} 年 `;
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}

/** Calendar records retain their original precision; they are not midnight instants. */
export function memoryDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!parts) return value;
  const year = Number(parts[1]);
  return `${year === new Date().getFullYear() ? '' : `${year} 年 `}${Number(parts[2])} 月${parts[3] ? ` ${Number(parts[3])} 日` : ''}`;
}
