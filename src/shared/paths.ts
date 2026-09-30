import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The same modules run from src/ (tsx, development) and from dist/src/ (compiled, production),
// so paths relative to a module's own location differ by one level. Everything outside the
// code — the knowledge base, the widget, the log files — is located from the project root.
function findProjectRoot(start: string): string {
  let dir = start;
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${start}`);
    dir = parent;
  }
  return dir;
}

export const PROJECT_ROOT = findProjectRoot(import.meta.dirname);

// True when running compiled JavaScript (production); false under tsx (development).
export const RUNNING_COMPILED = import.meta.url.endsWith('.js');

export const fromRoot = (...segments: string[]) => resolve(PROJECT_ROOT, ...segments);
