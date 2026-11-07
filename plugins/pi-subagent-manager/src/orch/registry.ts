import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SavedThread, SavedThreadView } from "../types.ts";

/** Every retained thread. Written first after each attach and whenever threads are removed. */
export const REGISTRY_ENTRY = "pi-subagent:registry:v1";
/**
 * What changed since the previous registry entry on the branch. Each child checkpoint changes a
 * few view fields of one thread; rewriting the whole registry for each grew root sessions by
 * gigabytes, and Pi holds every session entry in memory.
 */
export const REGISTRY_DELTA_ENTRY = "pi-subagent:registry-delta:v1";

export interface SavedRegistry {
  version: 1;
  rootSessionId: string;
  threads: SavedThread[];
}

/** A change to one thread since the previous registry entry on the branch. */
export type ThreadChange =
  /** An added thread, or one whose definition or inherited context changed. */
  | { thread: SavedThread }
  /** Only these view fields changed or were cleared. */
  | { path: string; view: Partial<SavedThreadView>; cleared?: (keyof SavedThreadView)[] };

export interface RegistryDelta {
  version: 1;
  rootSessionId: string;
  /** In registry order. Added threads follow every existing thread. */
  changes: ThreadChange[];
}

/**
 * The registry saved on a branch: its last full entry with every later delta applied in order.
 * Returns undefined when the branch has no registry. Throws on malformed entries.
 */
export function readRegistry(branch: readonly SessionEntry[]): SavedRegistry | undefined {
  const deltas: unknown[] = [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "custom") continue;
    if (entry.customType === REGISTRY_DELTA_ENTRY) deltas.push(entry.data);
    else if (entry.customType === REGISTRY_ENTRY)
      return applyDeltas(parseRegistry(entry.data), deltas.reverse());
  }
  if (deltas.length) throw new Error("Invalid registry format: delta without a full registry");
  return undefined;
}

function parseRegistry(data: unknown): SavedRegistry {
  const registry = data as Partial<SavedRegistry> | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.threads))
    throw new Error("Invalid registry format");
  return registry as SavedRegistry;
}

function parseDelta(data: unknown, rootSessionId: string): RegistryDelta {
  const delta = data as Partial<RegistryDelta> | undefined;
  if (delta?.version !== 1 || !Array.isArray(delta.changes))
    throw new Error("Invalid registry format");
  if (delta.rootSessionId !== rootSessionId)
    throw new Error("Invalid registry format: delta belongs to another root session");
  return delta as RegistryDelta;
}

function applyDeltas(base: SavedRegistry, deltas: readonly unknown[]): SavedRegistry {
  if (!deltas.length) return base;
  // Map insertion order is registry order: changes replace in place, added threads append.
  const threads = new Map(base.threads.map((thread) => [thread.view.path, thread]));
  if (threads.size !== base.threads.length)
    throw new Error("Invalid registry format: duplicate thread path");
  for (const data of deltas) {
    for (const change of parseDelta(data, base.rootSessionId).changes) {
      if ("thread" in change) {
        threads.set(change.thread.view.path, change.thread);
        continue;
      }
      const current = threads.get(change.path);
      if (!current) throw new Error(`Invalid registry format: unknown thread ${change.path}`);
      const view = { ...current.view, ...change.view };
      for (const field of change.cleared ?? []) delete view[field];
      threads.set(change.path, { ...current, view });
    }
  }
  return { ...base, threads: [...threads.values()] };
}

/** A thread as last written: each defined view field and the rest of the record, serialized. */
interface WrittenThread {
  view: Map<string, string>;
  rest: string;
}

function serialize(thread: SavedThread): WrittenThread {
  const { view, ...rest } = thread;
  const fields = Object.entries(view).flatMap(([field, value]): [string, string][] =>
    // JSON omits undefined fields, so they read back as cleared.
    value === undefined ? [] : [[field, JSON.stringify(value)]],
  );
  return { view: new Map(fields), rest: JSON.stringify(rest) };
}

function threadChange(
  thread: SavedThread,
  next: WrittenThread,
  previous: WrittenThread | undefined,
): ThreadChange | undefined {
  if (!previous || previous.rest !== next.rest) return { thread };
  const view: Record<string, unknown> = {};
  for (const [field, value] of next.view) {
    if (previous.view.get(field) !== value)
      view[field] = thread.view[field as keyof SavedThreadView];
  }
  const cleared = [...previous.view.keys()].filter((field) => !next.view.has(field));
  if (!Object.keys(view).length && !cleared.length) return undefined;
  return {
    path: thread.view.path,
    view,
    ...(cleared.length ? { cleared: cleared as (keyof SavedThreadView)[] } : {}),
  };
}

/** Appends registry entries so that readRegistry() on the current branch returns the last write. */
export class RegistryWriter {
  /** The threads, in order, that readRegistry() returns for the current branch. */
  private persisted: { rootSessionId: string; threads: Map<string, WrittenThread> } | undefined;

  constructor(
    private readonly append: (customType: string, data: SavedRegistry | RegistryDelta) => void,
  ) {}

  /** The session or branch changed: the next write must be a full registry. */
  reset(): void {
    this.persisted = undefined;
  }

  write(rootSessionId: string, threads: SavedThread[]): void {
    const next = new Map(threads.map((thread) => [thread.view.path, serialize(thread)]));
    const persisted = this.persisted;
    if (
      persisted &&
      persisted.rootSessionId === rootSessionId &&
      keepsOrder(persisted.threads, threads)
    ) {
      const changes = threads.flatMap((thread) => {
        const path = thread.view.path;
        const change = threadChange(thread, next.get(path)!, persisted.threads.get(path));
        return change ? [change] : [];
      });
      if (!changes.length) return;
      this.append(REGISTRY_DELTA_ENTRY, { version: 1, rootSessionId, changes });
    } else {
      this.append(REGISTRY_ENTRY, { version: 1, rootSessionId, threads });
    }
    // After the append: a failed write must not become the base for the next delta.
    this.persisted = { rootSessionId, threads: next };
  }
}

/** A delta cannot remove or reorder threads: every persisted path must keep its position. */
function keepsOrder(persisted: ReadonlyMap<string, unknown>, threads: readonly SavedThread[]) {
  let index = 0;
  for (const path of persisted.keys()) {
    if (threads[index]?.view.path !== path) return false;
    index++;
  }
  return true;
}
