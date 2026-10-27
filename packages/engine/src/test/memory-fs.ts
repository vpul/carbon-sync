import type { FileSystem } from '../ports.js';

/** In-memory vault for tests. Paths are ordinary Map keys; no folders exist. */
export class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`rename source missing: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, content);
  }
}
