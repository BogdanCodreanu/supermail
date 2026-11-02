import { Keyboard, PanelRightClose } from 'lucide-react';
import { useState } from 'react';
import { bindingsFor, SECTIONS, type Binding, type KeyContext } from '../keys/keymap';
import { useShortcuts } from '../keys/useShortcuts';
import { useNarrowWindow, usePanelCollapsed } from '../state/ui';
import { Kbd } from './Kbd';

interface Row { id: string; label: string; keys: string[]; raw?: boolean }

/** The panel's title: the screen the keys below belong to. */
const TITLES: Record<KeyContext, string> = { list: 'Inbox', thread: 'Reading', compose: 'Writing', skipped: 'Skipped', settings: 'Settings', search: 'Search', spam: 'Spam', spamReader: 'Spam' };

/** Pairs shown as one row: the first id carries the row, the second is folded into it. */
const PAIRS: [string, string, string][] = [
  ['next', 'prev', 'Next / previous'],
  ['extendDown', 'extendUp', 'Extend'],
  ['nextMessage', 'prevMessage', 'Next / previous message'],
  ['nextGroup', 'prevGroup', 'Next / previous group'],
];

/** Folds pairs and the 1–9 group keys into single rows so the panel stays short (mockup option B). */
function rows(bindings: Binding[]): Row[] {
  const out: Row[] = [];
  const find = (id: string) => bindings.find((b) => b.id === id);
  for (const b of bindings) {
    const pair = PAIRS.find(([first, second]) => (b.id === first || b.id === second) && find(first) && find(second));
    if (pair) {
      if (b.id === pair[0]) out.push({ id: `${pair[0]}Pair`, label: pair[2], keys: [...b.keys, ...find(pair[1])!.keys] });
    } else if (/^group\d$/.test(b.id)) {
      if (b.id === 'group1') out.push({ id: 'groupN', label: 'Go to group', keys: ['1–9'], raw: true });
    } else {
      out.push({ id: b.id, label: b.label, keys: b.keys });
    }
  }
  return out;
}

/** The window width below which the panel gives its room to the list. */
const NARROW_WINDOW = 1099;

/**
 * The always-visible cheat-sheet on the right. `?` collapses it; the choice is remembered. In a narrow window it
 * stays on its rail whatever the choice, and `?` opens it over the page for the moment, leaving the choice alone.
 */
export function ShortcutPanel({ context }: { context: KeyContext }) {
  const [savedCollapsed, setSavedCollapsed] = usePanelCollapsed();
  const narrow = useNarrowWindow(NARROW_WINDOW);
  const [peeking, setPeeking] = useState(false);
  const collapsed = narrow ? !peeking : savedCollapsed;
  const setCollapsed = narrow ? (c: boolean) => setPeeking(!c) : setSavedCollapsed;
  useShortcuts(context, { togglePanel: () => setCollapsed(!collapsed) });

  if (collapsed) {
    return (
      <aside aria-label="Keyboard shortcuts" className="hidden w-10 shrink-0 border-l border-line bg-panel md:flex md:flex-col md:items-center md:pt-2">
        <button
          type="button"
          aria-label="Show shortcuts"
          title="Show shortcuts (?)"
          onClick={() => setCollapsed(false)}
          className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
        >
          <Keyboard size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </aside>
    );
  }

  const sections = bindingsFor(context);
  return (
    <aside aria-label="Keyboard shortcuts" className={`hidden w-60 shrink-0 overflow-y-auto border-l border-line bg-panel px-4 py-2 md:block ${narrow ? 'absolute inset-y-0 right-0 z-30 shadow-lg' : ''}`}>
      <div className="flex h-8 items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">{TITLES[context]}</h2>
        <button
          type="button"
          aria-label="Hide shortcuts"
          title="Hide shortcuts (?)"
          onClick={() => setCollapsed(true)}
          className="-mr-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
        >
          <PanelRightClose size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {SECTIONS.filter((s) => sections[s].length > 0).map((s, i) => (
        <section key={s} className={i > 0 ? 'mt-2 border-t border-line pt-2' : 'mt-2'}>
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-faint">{s}</h3>
          <ul>
            {rows(sections[s]).map((r) => (
              <li key={r.id} className="flex min-h-7 items-center justify-between gap-2">
                <span className="text-xs text-muted">{r.label}</span>
                <span className="flex shrink-0 justify-end gap-1">
                  {r.keys.map((k) => (
                    <Kbd key={k} k={k} raw={r.raw} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
