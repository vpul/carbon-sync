import type { ClientMessage, ServerMessage } from '@carbon-sync/protocol';

/** Vault-relative POSIX paths. Implementations should create parent folders on write. */
export interface FileSystem {
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Persisted per device per vault. */
export interface StateStore {
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}

export interface SyncState {
  cursor: number;
  deviceId: string;
  files: Record<string, { rev: number; hash: string; base: string }>;
}

/** Wraps a WebSocket (or a test loopback). */
export interface Transport {
  connect(url: string): Promise<Connection>;
}

export interface Connection {
  send(msg: ClientMessage): void;
  close(): void;
  onMessage(cb: (m: ServerMessage) => void): void;
  onClose(cb: (code: number) => void): void;
}

/** A browser timer id (number) or a Node `Timeout` object. Opaque to the engine. */
export type TimerHandle = number | object;

/** Injected so tests control debounce and reconnect timing. */
export interface Clock {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}
