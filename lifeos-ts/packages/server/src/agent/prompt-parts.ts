import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { MONOREPO_ROOT } from '../root.js';

const ROOT = MONOREPO_ROOT;
const PROMPT_PARTS_DIR = resolve(ROOT, 'prompt-parts');
const USER_DATA_DIR = resolve(ROOT, '.user-data');

/**
 * Loads a prompt file with a 3-tier override chain:
 *   1. {base}/{name}  (filesystem — handles both built-in agents/ and .user-data/agents/)
 *   2. .user-data/prompt-parts/{name}  (user override of generic prompts)
 *   3. prompt-parts/{name}  (generic fallback)
 *
 * In the Java version, tier 1 tried classpath then filesystem.
 * Since we're not using classpath in TS, we just check filesystem.
 */
export function loadPrompt(base: string, name: string): string {
  // Tier 1: look in the agent's own directory
  const agentPath = resolve(ROOT, base, name);
  if (existsSync(agentPath)) {
    return readFileSync(agentPath, 'utf-8').trim();
  }

  // Tier 2: user override in .user-data/prompt-parts/
  if (base !== 'prompt-parts') {
    const userOverride = join(USER_DATA_DIR, 'prompt-parts', name);
    if (existsSync(userOverride)) {
      return readFileSync(userOverride, 'utf-8').trim();
    }
  }

  // Tier 3: generic fallback
  if (base !== 'prompt-parts') {
    return loadPrompt('prompt-parts', name);
  }

  // Final: check prompt-parts dir itself
  const fallback = resolve(PROMPT_PARTS_DIR, name);
  if (existsSync(fallback)) {
    return readFileSync(fallback, 'utf-8').trim();
  }

  return '';
}

/**
 * Loads a generic prompt file from prompt-parts/{name}.
 */
export function loadGenericPrompt(name: string): string {
  return loadPrompt('prompt-parts', name);
}
