'use client';
import { createContext, useContext } from 'react';

/**
 * F335 交付三：聊天里的作品卡底行写「谁 · 第 N 版 · 时间」（北极星稿第 10 张）。时间是这条消息的时间；守望猫发的消息
 * （回话带持久的 `turnExecution.executionKind = 'watcher'`）传 `byline: 'watcher'`，底行就写「守望猫 · 小太阳」。
 */
export interface WorkCardMessage {
  at?: number;
  byline?: 'cat' | 'watcher';
}

export const WorkCardMessageContext = createContext<WorkCardMessage>({});

export function useWorkCardMessage(): WorkCardMessage {
  return useContext(WorkCardMessageContext);
}

/** Same day: 02:05. Otherwise: 11/2 02:05 (as on the works page). */
export function workCardTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}
