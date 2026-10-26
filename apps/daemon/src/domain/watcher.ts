import { type FSWatcher, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isSyncable } from '@carbon-sync/protocol';

/** The subset of `SyncEngine` the watcher drives. */
export interface LocalChangeSink {
  notifyLocalChange(path: string): void;
  notifyLocalDelete(path: string): void;
}

export interface WatcherOptions {
  dir: string;
  ignore?: readonly string[];
  sink: LocalChangeSink;
}

/**
 * Map filesystem notifications to engine calls. Debouncing, echo suppression,
 * and rename correlation are the engine's job; a rename simply arrives as a
 * delete of the old path and a change of the new one.
 */
export function watchVault({ dir, ignore = [], sink }: WatcherOptions): FSWatcher {
  return watch(dir, { recursive: true }, (_event, filename) => {
    if (filename === null) {
      return;
    }
    const relative = filename.toString().split(sep).join('/').replace(/^\.\//, '');
    if (!isSyncable(relative, ignore)) {
      return;
    }
    void stat(join(dir, ...relative.split('/'))).then(
      () => sink.notifyLocalChange(relative),
      (error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          sink.notifyLocalDelete(relative);
        }
      },
    );
  });
}
