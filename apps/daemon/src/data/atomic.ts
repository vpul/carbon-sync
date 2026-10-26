import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for the new file, before umask. Omit to use the default 0o666 & ~umask. */
  mode?: number;
}

/**
 * Write in the target directory, then rename over the destination. A crash
 * leaves either the old file or the new one, never a truncated file.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temp = join(dirname(file), `.carbon-tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temp, data, {
      encoding: 'utf8',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
