import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../lib/db.js';
import type { Actor } from './access.js';

/**
 * In-transaction task event bus. Core task services emit; extensions (automation rules,
 * escalation, notifications) subscribe. Listeners run inside the same transaction as the
 * change, so they must be fast and should enqueue jobs for slow work.
 */
export type TaskEventType = 'task.created' | 'task.status_changed' | 'task.reviewed' | 'task.reopened' | 'task.reassigned' | 'task.updated' | 'blocker.raised';
export interface TaskEvent {
  type: TaskEventType;
  tenantId: string;
  actorId: string | null;
  task: any;              // task row after the change
  from?: string | null;   // previous status (status_changed / reopened)
  to?: string | null;     // new status
  details?: Record<string, unknown>;
  /** Depth of automation-triggered changes; listeners must not act when depth >= 3 (loop guard). */
  depth: number;
}
type Listener = (db: Db, ev: TaskEvent, actor: Actor | null) => Promise<void>;
const listeners: Listener[] = [];
export function onTaskEvent(l: Listener) { listeners.push(l); }

// Depth is tracked per async call chain (not process-wide), so concurrent requests never inflate each other's depth.
const depthStore = new AsyncLocalStorage<number>();
export function currentAutomationDepth() { return depthStore.getStore() ?? 0; }
/** Run fn as an automation-originated change: events it emits carry depth + 1. */
export async function asAutomation<T>(fn: () => Promise<T>): Promise<T> {
  return depthStore.run(currentAutomationDepth() + 1, fn);
}
export async function emitTaskEvent(db: Db, actor: Actor | null, ev: Omit<TaskEvent, 'depth'>) {
  const full: TaskEvent = { ...ev, depth: currentAutomationDepth() };
  for (const l of listeners) await l(db, full, actor);
}
