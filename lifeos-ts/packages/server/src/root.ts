import { resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Absolute path to the lifeos-ts monorepo root.
 * Resolved from this file's location (packages/server/src/root.ts → lifeos-ts/).
 * Use this instead of process.cwd() so the server works regardless of which
 * directory `bun dev` is invoked from.
 */
// root.ts is at packages/server/src/root.ts
// resolve(file, '..') = packages/server/src/
// resolve(file, '../..') = packages/server/
// resolve(file, '../../..') = packages/
// resolve(file, '../../../..') = lifeos-ts/  ← monorepo root
export const MONOREPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
