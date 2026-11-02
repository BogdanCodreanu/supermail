// The build stamps public/sw.js (see vite.config.ts), so a new release gets a new cache.

/** The same hashed files give the same id, in any order. */
export function buildId(files: string[]): string {
  let hash = 0x811c9dc5; // FNV-1a
  for (const char of [...files].sort().join('\n')) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function stampBuild(source: string, id: string): string {
  return source.replaceAll('__BUILD__', id);
}
