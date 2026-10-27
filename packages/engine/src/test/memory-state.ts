import type { StateStore, SyncState } from '../ports.js';

/** Per-device state kept in memory; `save` clones so later mutation cannot leak in. */
export class MemoryStateStore implements StateStore {
  state: SyncState;
  saves = 0;

  constructor(initial?: SyncState) {
    this.state = initial ? structuredClone(initial) : { cursor: 0, deviceId: '', files: {} };
  }

  async load(): Promise<SyncState> {
    return structuredClone(this.state);
  }

  async save(state: SyncState): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }

  /** Copy of the last persisted state, safe for assertions. */
  snapshot(): SyncState {
    return structuredClone(this.state);
  }
}
