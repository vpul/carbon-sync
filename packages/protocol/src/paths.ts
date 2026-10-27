export const MAX_PATH_LENGTH = 512;

const ALLOWED_EXTENSIONS: Record<string, true> = {
  '.md': true,
  '.canvas': true,
  '.txt': true,
  '.json': true,
};
const GLOB_SPECIALS = '\\^$.|+()[]{}?';

/**
 * True for a normalized, vault-relative POSIX path: no leading slash, no
 * backslash, no NUL, no empty/`.`/`..` segment, at most 512 characters.
 */
export function isValidPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Compile one simple glob (`*` within a segment, `**` across segments) to a full match regex. */
function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/^\.\//, '').replace(/^\/+/, '');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized.charAt(i);
    if (char === '*') {
      if (normalized.charAt(i + 1) === '*') {
        i += 1;
        if (normalized.charAt(i + 1) === '/') {
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (GLOB_SPECIALS.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

const globCache = new Map<string, RegExp>();

function cachedGlob(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = globToRegExp(glob);
  if (globCache.size >= 256) {
    globCache.clear();
  }
  globCache.set(glob, compiled);
  return compiled;
}

/**
 * PLAN rule 9: skip reserved directories, any dot-prefixed segment, and files
 * outside the text extension allowlist. `extraIgnore` globs match the full
 * vault-relative path (for example `Private/**`).
 */
export function isSyncable(path: string, extraIgnore: readonly string[] = []): boolean {
  if (!isValidPath(path)) {
    return false;
  }
  // Any dot-prefixed segment is skipped. That covers the Obsidian config folder
  // without hardcoding its name (users can rename it), plus .trash, .git and .carbon.
  const segments = path.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) {
    return false;
  }
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  if (ALLOWED_EXTENSIONS[extension] !== true) {
    return false;
  }
  return !extraIgnore.some((glob) => cachedGlob(glob).test(path));
}
