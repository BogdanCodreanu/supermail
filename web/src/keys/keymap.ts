// The single source for keyboard shortcuts: handlers (useShortcuts) and the cheat-sheet panel both
// read BINDINGS, so the panel can never drift from what the keys actually do. Binding ids are used
// by later tasks as handler names.

export type KeyContext = 'list' | 'thread' | 'compose' | 'skipped' | 'settings' | 'search' | 'spam' | 'spamReader';
export type Section = 'Navigate' | 'Triage' | 'Write' | 'Teach' | 'Find' | 'View';
export interface Binding { id: string; keys: string[]; label: string; section: Section; contexts: KeyContext[] }

/**
 * Key syntax: `KeyboardEvent.key` for the key itself (single characters lowercase), optionally
 * prefixed with `Ctrl+` (Ctrl or ⌘). Shift is implied by the character (`?`, `+`), except on a letter
 * bound separately from its plain key (`Shift+j`). Tab is never bound: it moves focus, as in any web page.
 */
export const SECTIONS: Section[] = ['Navigate', 'Triage', 'Write', 'Teach', 'Find', 'View'];
export const ALL_CONTEXTS: KeyContext[] = ['list', 'thread', 'compose', 'skipped', 'settings', 'search', 'spam', 'spamReader'];

/** Every screen except the composer (which owns the keyboard while typing). */
const PAGES: KeyContext[] = ['list', 'thread', 'skipped', 'settings', 'search', 'spam', 'spamReader'];
/** Screens with a list of threads to move through. */
const LISTS: KeyContext[] = ['list', 'skipped', 'search', 'spam'];

const GROUP_KEYS: Binding[] = Array.from({ length: 9 }, (_, i) => ({
  id: `group${i + 1}`,
  keys: [`${i + 1}`],
  label: `Go to group ${i + 1}`,
  section: 'Navigate' as const,
  contexts: ['list'] as KeyContext[],
}));

export const BINDINGS: Binding[] = [
  // Navigate
  { id: 'next', keys: ['j'], label: 'Next', section: 'Navigate', contexts: ['list', 'thread', 'skipped', 'search', 'spam'] },
  { id: 'prev', keys: ['k'], label: 'Previous', section: 'Navigate', contexts: ['list', 'thread', 'skipped', 'search', 'spam'] },
  { id: 'nextMessage', keys: ['n'], label: 'Next message', section: 'Navigate', contexts: ['thread'] },
  { id: 'prevMessage', keys: ['p'], label: 'Previous message', section: 'Navigate', contexts: ['thread'] },
  { id: 'open', keys: ['Enter'], label: 'Open', section: 'Navigate', contexts: LISTS },
  { id: 'back', keys: ['Escape'], label: 'Back', section: 'Navigate', contexts: ['thread', 'compose', 'skipped', 'settings', 'search', 'spam', 'spamReader'] },
  { id: 'nextGroup', keys: [']'], label: 'Next group', section: 'Navigate', contexts: ['list'] },
  { id: 'prevGroup', keys: ['['], label: 'Previous group', section: 'Navigate', contexts: ['list'] },
  ...GROUP_KEYS,
  { id: 'cycleAccount', keys: ['`'], label: 'Switch account', section: 'Navigate', contexts: ['list'] },
  // Triage
  { id: 'done', keys: ['e'], label: 'Done', section: 'Triage', contexts: ['list', 'thread'] },
  { id: 'snooze', keys: ['h'], label: 'Snooze', section: 'Triage', contexts: ['list', 'thread'] },
  { id: 'reportSpam', keys: ['!'], label: 'Report spam', section: 'Triage', contexts: ['list', 'thread'] },
  { id: 'toggleRead', keys: ['u'], label: 'Read / unread', section: 'Triage', contexts: ['list', 'thread'] },
  { id: 'restore', keys: ['i'], label: 'Restore to inbox', section: 'Triage', contexts: ['skipped'] },
  { id: 'notSpam', keys: ['i'], label: 'Not spam', section: 'Triage', contexts: ['spam', 'spamReader'] },
  { id: 'undo', keys: ['z'], label: 'Undo', section: 'Triage', contexts: ['list', 'thread', 'skipped', 'spam', 'spamReader'] },
  { id: 'select', keys: ['x'], label: 'Select', section: 'Triage', contexts: ['list'] },
  { id: 'selectToBottom', keys: ['Ctrl+a'], label: 'Select to the bottom', section: 'Triage', contexts: ['list'] },
  { id: 'extendDown', keys: ['Shift+j'], label: 'Extend selection down', section: 'Triage', contexts: ['list'] },
  { id: 'extendUp', keys: ['Shift+k'], label: 'Extend selection up', section: 'Triage', contexts: ['list'] },
  { id: 'clearSelection', keys: ['Escape'], label: 'Clear selection', section: 'Triage', contexts: ['list'] },
  // Write
  { id: 'reply', keys: ['r'], label: 'Reply', section: 'Write', contexts: ['list', 'thread'] },
  { id: 'replyAll', keys: ['a'], label: 'Reply all', section: 'Write', contexts: ['list', 'thread'] },
  { id: 'forward', keys: ['f'], label: 'Forward', section: 'Write', contexts: ['list', 'thread'] },
  { id: 'compose', keys: ['c'], label: 'Compose', section: 'Write', contexts: PAGES },
  { id: 'send', keys: ['Ctrl+Enter'], label: 'Send', section: 'Write', contexts: ['compose'] },
  // Teach
  { id: 'important', keys: ['+'], label: 'Important to me', section: 'Teach', contexts: ['list', 'thread'] },
  { id: 'notImportant', keys: ['-'], label: 'Not important', section: 'Teach', contexts: ['list', 'thread'] },
  { id: 'groupTo', keys: ['l'], label: 'Always group to…', section: 'Teach', contexts: ['list', 'thread'] },
  // Find
  { id: 'search', keys: ['/'], label: 'Search', section: 'Find', contexts: PAGES },
  { id: 'palette', keys: ['Ctrl+k'], label: 'Command palette', section: 'Find', contexts: PAGES },
  // View
  { id: 'togglePanel', keys: ['?'], label: 'Hide / show shortcuts', section: 'View', contexts: ALL_CONTEXTS },
  // After Done: in the palette "done" + Enter has to stay the action, not this view toggle.
  { id: 'toggleDone', keys: ['d'], label: 'Show / hide done', section: 'View', contexts: ['list'] },
];

export function bindingsFor(ctx: KeyContext): Record<Section, Binding[]> {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []])) as unknown as Record<Section, Binding[]>;
  for (const b of BINDINGS) if (b.contexts.includes(ctx)) out[b.section].push(b);
  return out;
}
