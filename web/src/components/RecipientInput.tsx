import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  forwardRef,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { AddressDTO, ThreadDetailDTO, ThreadPage } from '@supermail/shared';
import { useIsPhone } from '../lib/useIsPhone';
import { useVisualViewport } from '../lib/useVisualViewport';

export interface Person { name: string | null; email: string }

const MAX_SUGGESTIONS = 6;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL.test(email);
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t;
}

/** Parses one mailbox: `"Name" <a@b>`, `Name <a@b>`, `<a@b>` or `a@b`. */
export function parseAddress(raw: string): Person {
  const s = raw.trim();
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(s);
  if (angle) {
    const name = unquote(angle[1] ?? '').trim();
    return { name: name || null, email: (angle[2] ?? '').trim() };
  }
  return { name: null, email: unquote(s) };
}

/** The RFC 5322 form the server accepts: `a@b`, `Name <a@b>`, or a quoted name when it needs one. */
export function formatAddress(p: Person): string {
  if (!p.name) return p.email;
  const name = /[",;:<>@()[\]\\]/.test(p.name) ? `"${p.name.replace(/(["\\])/g, '\\$1')}"` : p.name;
  return `${name} <${p.email}>`;
}

/**
 * Splits typed or pasted text into recipients: on commas, semicolons and line breaks outside quotes
 * and angle brackets, and on spaces between bare addresses (`a@b c@d`).
 */
export function parseRecipients(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    if (!quoted && !angle && (c === ',' || c === ';' || c === '\n' || c === '\r')) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim().replace(/\s+/g, ' ');
    if (!p) continue;
    const words = p.split(' ');
    if (!p.includes('<') && !p.includes('"') && words.length > 1 && words.every((w) => w.includes('@'))) out.push(...words);
    else out.push(formatAddress(parseAddress(p)));
  }
  return out;
}

export function isValidRecipient(raw: string): boolean {
  return isValidEmail(parseAddress(raw).email);
}

/**
 * Everyone the app already knows, from the TanStack Query cache: senders in thread lists, and
 * senders and recipients in loaded threads. Most frequent first. `exclude` holds lowercased emails.
 */
export function knownPeople(qc: QueryClient, exclude: ReadonlySet<string>): Person[] {
  const seen = new Map<string, { p: Person; count: number; last: number }>();
  const add = (name: string | null | undefined, email: string | null | undefined, at: number) => {
    if (!email) return;
    const key = email.toLowerCase();
    if (exclude.has(key) || !isValidEmail(email)) return;
    const hit = seen.get(key);
    if (hit) {
      hit.count++;
      hit.last = Math.max(hit.last, at);
      if (!hit.p.name && name) hit.p.name = name;
    } else seen.set(key, { p: { name: name || null, email }, count: 1, last: at });
  };
  const page = (p: ThreadPage | undefined) => {
    for (const t of p?.threads ?? []) add(t.fromName, t.fromEmail, t.lastMessageAt);
  };
  for (const q of qc.getQueryCache().getAll()) {
    const head = q.queryKey[0];
    const data = q.state.data;
    if (!data) continue;
    if (head === 'threads') for (const p of (data as InfiniteData<ThreadPage>).pages ?? []) page(p);
    else if (head === 'search' || head === 'skipped') page(data as ThreadPage);
    else if (head === 'thread') {
      for (const m of (data as ThreadDetailDTO).messages ?? []) {
        const each = (a: AddressDTO) => add(a.name, a.email, m.date);
        each(m.from);
        m.to.forEach(each);
        m.cc.forEach(each);
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || b.last - a.last).map((v) => v.p);
}

function matches(p: Person, q: string): boolean {
  const email = p.email.toLowerCase();
  if (email.startsWith(q) || (email.split('@')[1] ?? '').startsWith(q)) return true;
  const name = (p.name ?? '').toLowerCase();
  return name.startsWith(q) || name.split(/[\s.\-_]+/).some((w) => w.startsWith(q));
}

/** The suggestions: under the field, or on the phone in a full-width strip right above the keyboard. */
function SuggestionList({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const phone = useIsPhone();
  const area = useVisualViewport();
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={label}
      style={phone ? { bottom: area?.keyboard ?? 0 } : undefined}
      className="fixed inset-x-0 z-20 max-h-40 overflow-y-auto border-t border-line bg-bg py-1 shadow-lg md:absolute md:inset-x-auto md:left-0 md:top-full md:mt-1 md:max-h-none md:w-full md:max-w-sm md:overflow-hidden md:rounded-md md:border"
    >
      {children}
    </ul>
  );
}

export interface RecipientInputHandle { focus(): void }

export interface RecipientInputProps {
  label: string;
  values: string[];
  onChange(values: string[]): void;
  /** Text typed but not yet turned into a chip (sending includes it). */
  pending: string;
  onPending(text: string): void;
  /** Lowercased emails never suggested (the owner's own addresses). */
  exclude?: ReadonlySet<string>;
  autoFocus?: boolean;
}

/**
 * Recipient chips. Enter, comma, Tab or leaving the field turns the typed text into chips; invalid
 * addresses show in red. Backspace in the empty field selects the last chip, a second Backspace
 * removes it. Click a chip to edit it. Suggestions come from people in the app's caches.
 */
export const RecipientInput = forwardRef<RecipientInputHandle, RecipientInputProps>(function RecipientInput(
  { label, values, onChange, pending, onPending, exclude, autoFocus },
  ref,
) {
  const qc = useQueryClient();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  // The latest typed text, so a commit and the blur right after it (Tab) never add it twice.
  const typed = useRef(pending);
  typed.current = pending;
  const [selectedChip, setSelectedChip] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const q = pending.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!q) return [];
    const taken = new Set([...(exclude ?? []), ...values.map((v) => parseAddress(v).email.toLowerCase())]);
    return knownPeople(qc, taken)
      .filter((p) => matches(p, q))
      .slice(0, MAX_SUGGESTIONS);
  }, [q, qc, exclude, values]);
  // A complete address typed by hand wins over suggestions: nothing is preselected then.
  const typedIsEmail = isValidRecipient(pending.trim());
  const showList = open && suggestions.length > 0;
  const activeIndex = showList ? (active >= 0 && active < suggestions.length ? active : typedIsEmail ? -1 : 0) : -1;

  const setTyped = (text: string) => {
    typed.current = text;
    onPending(text);
  };

  const commit = (): boolean => {
    const add = parseRecipients(typed.current);
    setTyped('');
    setOpen(false);
    setActive(-1);
    if (add.length) onChange([...values, ...add]);
    return add.length > 0;
  };

  const pick = (p: Person) => {
    setTyped('');
    setOpen(false);
    setActive(-1);
    onChange([...values, formatAddress(p)]);
    input.current?.focus();
  };

  const edit = (i: number) => {
    const extra = parseRecipients(typed.current);
    const rest = values.filter((_, j) => j !== i);
    onChange([...rest, ...extra]);
    setTyped(values[i] ?? '');
    setSelectedChip(null);
    input.current?.focus();
  };

  const remove = (i: number) => {
    onChange(values.filter((_, j) => j !== i));
    setSelectedChip(null);
    input.current?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+Enter sends; sending reads the typed text too
    if (e.key !== 'Backspace' && e.key !== 'Delete' && selectedChip !== null) setSelectedChip(null);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (suggestions.length === 0) return;
        e.preventDefault();
        const n = suggestions.length;
        const from = showList ? activeIndex : -1;
        setOpen(true);
        setActive(e.key === 'ArrowDown' ? (from + 1) % n : from <= 0 ? n - 1 : from - 1);
        return;
      }
      case 'Enter':
        if (activeIndex >= 0) {
          e.preventDefault();
          pick(suggestions[activeIndex]!);
        } else if (pending.trim()) {
          e.preventDefault();
          commit();
        }
        return;
      case 'Tab':
        // Tab completes, then moves on as usual.
        if (e.shiftKey) return;
        if (activeIndex >= 0) pick(suggestions[activeIndex]!);
        else if (pending.trim()) commit();
        return;
      case ',':
      case ';':
        e.preventDefault();
        if (pending.trim()) commit();
        return;
      case 'Escape':
        if (showList) {
          e.preventDefault();
          setOpen(false);
        } else if (selectedChip !== null) {
          e.preventDefault();
          setSelectedChip(null);
        }
        return;
      case 'Backspace':
      case 'Delete':
        if (pending !== '' || values.length === 0) return;
        e.preventDefault();
        if (selectedChip !== null) remove(selectedChip);
        else if (e.key === 'Backspace') setSelectedChip(values.length - 1);
        return;
    }
  };

  const onPaste = (e: ReactClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[,;\n]/.test(text) && parseRecipients(text).length < 2) return;
    e.preventDefault();
    const add = parseRecipients(`${typed.current}, ${text}`);
    setTyped('');
    setOpen(false);
    if (add.length) onChange([...values, ...add]);
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div
      role="group"
      aria-label={label}
      className="relative flex min-w-0 flex-1 cursor-text flex-wrap items-center gap-x-1 md:gap-1 md:py-1"
      onMouseDown={(e) => {
        // A click on the empty part of the field types into it.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        input.current?.focus();
      }}
    >
      {values.map((v, i) => {
        const p = parseAddress(v);
        const valid = isValidEmail(p.email);
        const selected = selectedChip === i;
        const tone = !valid ? 'bg-danger-bg text-danger' : selected ? 'bg-sel text-fg ring-1 ring-accent' : 'bg-hover text-fg';
        return (
          <span
            key={`${v}-${i}`}
            data-testid="recipient-chip"
            data-invalid={valid ? undefined : 'true'}
            data-selected={selected ? 'true' : undefined}
            className={`my-1.5 inline-flex h-8 max-w-full items-center rounded text-xs md:my-0 md:h-6 ${tone} ${!valid && selected ? 'ring-1 ring-danger' : ''}`}
          >
            <button
              type="button"
              title={valid ? v : `Not a valid email address: ${v}`}
              aria-label={valid ? `Edit ${v}` : `Edit ${v} (not a valid email address)`}
              onClick={() => edit(i)}
              className="h-11 min-w-0 cursor-pointer truncate rounded-l pl-2 pr-1 hover:underline md:h-6"
            >
              {p.name ?? p.email}
            </button>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              title="Remove"
              onClick={() => remove(i)}
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-r opacity-60 transition-opacity duration-150 ease-out hover:opacity-100 max-md:active:opacity-100 md:h-6 md:w-6"
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </span>
        );
      })}
      <input
        ref={input}
        role="combobox"
        aria-label={`${label} recipients`}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        spellCheck={false}
        value={pending}
        autoFocus={autoFocus}
        onChange={(e) => {
          setTyped(e.target.value);
          setSelectedChip(null);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          commit();
          setSelectedChip(null);
        }}
        // The composer row shows focus (FIELD_ROW in Composer), so the bare input draws no ring of its own. On the phone an
        // idle one next to chips takes no room: it would leave a blank line under a chip that fills the row.
        className={`h-11 min-w-40 flex-1 bg-transparent text-[16px] focus-visible:outline-none md:h-6 md:text-sm ${values.length > 0 && !pending ? 'max-md:[&:not(:focus)]:h-0 max-md:[&:not(:focus)]:w-0 max-md:[&:not(:focus)]:min-w-0 max-md:[&:not(:focus)]:flex-none' : ''}`}
      />
      {showList && (
        <SuggestionList id={listId} label={`${label} suggestions`}>
          {suggestions.map((p, i) => (
            <li
              key={p.email}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
              className={`flex min-h-11 cursor-pointer items-center gap-2 px-4 max-md:active:bg-hover md:min-h-0 md:items-baseline md:px-3 md:py-1 ${i === activeIndex ? 'bg-sel' : 'hover:bg-hover'}`}
            >
              <span className="truncate text-sm">{p.name ?? p.email}</span>
              {p.name && <span className="truncate text-xs text-faint">{p.email}</span>}
            </li>
          ))}
        </SuggestionList>
      )}
    </div>
  );
});
