import { merge } from './merge.js';

/**
 * The three-way decision shared by incoming changes and rejected pushes.
 * `base` is null when there is no shared base or the last agreed state was a
 * tombstone; contents are compared by string equality and hashing stays in the
 * engine.
 */
export type Resolution =
  | { action: 'noop-adopt' }
  | { action: 'write-remote' }
  | { action: 'remove-local' }
  | { action: 'keep-local-push' }
  | { action: 'merge'; merged: string }
  | { action: 'conflict-copy' };

export interface ResolveInput {
  base: string | null;
  local: string | null;
  remote: string | null;
}

export function resolve({ base, local, remote }: ResolveInput): Resolution {
  if (remote === null) {
    if (local === null) {
      return { action: 'noop-adopt' };
    }
    // A local edit survives a remote delete; an untouched copy goes away.
    if (base !== null && local === base) {
      return { action: 'remove-local' };
    }
    return { action: 'keep-local-push' };
  }
  if (local === null) {
    // Remote edit, local delete: the remote content comes back.
    return { action: 'write-remote' };
  }
  if (local === remote) {
    return { action: 'noop-adopt' };
  }
  if (base === null) {
    return { action: 'conflict-copy' };
  }
  if (local === base) {
    return { action: 'write-remote' };
  }
  return { action: 'merge', merged: merge(base, local, remote) };
}
