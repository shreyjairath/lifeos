import { resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Absolute path to the project root.
 * .user-data/, agents/, prompt-parts/, and config.yml all live here.
 * Resolved from this file's location so the server works regardless of invocation directory.
 */
// root.ts is at packages/server/src/root.ts
// resolve(file, '..') = packages/server/src/
// resolve(file, '../..') = packages/server/
// resolve(file, '../../..') = packages/
// resolve(file, '../../../..') = project root  ← .user-data lives here
export const MONOREPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
