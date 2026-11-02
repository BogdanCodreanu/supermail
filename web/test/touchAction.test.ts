import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom has no cascade, so this reads the CSS Tailwind really builds: a touch-action rule that wins over `touch-pan-y`
// on a row makes the browser cancel every swipe, and only a real phone showed it.
describe('touch-action in the built CSS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-css-'));
  const out = join(dir, 'out.css');
  execFileSync('npx', ['tailwindcss', '-i', 'src/styles.css', '-o', out], { cwd: process.cwd(), stdio: 'ignore' });
  const css = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true });

  it('lets the row utility win over the global tap rule', () => {
    const global = css.indexOf("[role='option']");
    const utility = css.indexOf('.touch-pan-y');
    expect(global).toBeGreaterThan(-1);
    expect(utility).toBeGreaterThan(-1);
    expect(utility).toBeGreaterThan(global);
  });
});
