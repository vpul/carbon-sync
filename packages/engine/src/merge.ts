import { reconcile } from 'reconcile-text';

/**
 * Three-way word merge. This module is the only place in the repo that imports
 * `reconcile-text`; every other module goes through this signature.
 */
export function merge(base: string, mine: string, theirs: string): string {
  return reconcile(base, mine, theirs, 'Word').text;
}
