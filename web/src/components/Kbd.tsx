const NAMES: Record<string, string> = { Enter: '↵', Escape: 'Esc', Tab: 'Tab', Ctrl: 'Ctrl' };

/** Splits a keymap key (`Ctrl+Enter`, `Shift+j`) into the caps to draw (`Ctrl`, `↵`). */
export function keyCaps(key: string): string[] {
  const parts = key.startsWith('Ctrl+') ? ['Ctrl', key.slice(5)] : key.startsWith('Shift+') ? ['Shift', key.slice(6)] : [key];
  return parts.map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}

/** One key cap. `k` is either a keymap key (`e`, `Ctrl+k`) or literal text when `raw` is set. */
export function Kbd({ k, raw = false }: { k: string; raw?: boolean }) {
  const caps = raw ? [k] : keyCaps(k);
  return (
    <span className="inline-flex gap-0.5" data-key={k}>
      {caps.map((c, i) => (
        <kbd
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 border-kbd-border bg-kbd px-1 font-mono text-2xs font-semibold not-italic leading-none text-kbd-fg"
        >
          {c}
        </kbd>
      ))}
    </span>
  );
}
