import { Archive, ArrowLeft, Inbox, OctagonAlert, Pencil, Search, Settings, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { KeyContext } from '../keys/keymap';
import { useShortcuts } from '../keys/useShortcuts';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';
import { AppBar } from './phone/AppBar';
import { ShortcutPanel } from './ShortcutPanel';

const NAV: { to: string; label: string; title: string; icon: LucideIcon; end: boolean }[] = [
  { to: '/', label: 'Inbox', title: 'Inbox', icon: Inbox, end: true },
  { to: '/skipped', label: 'Skipped', title: 'Skipped your inbox', icon: Archive, end: false },
  { to: '/spam', label: 'Spam', title: 'Spam', icon: OctagonAlert, end: false },
  { to: '/settings', label: 'Settings', title: 'Settings', icon: Settings, end: false },
];

/** Screens where Escape simply goes back (the thread and the composer handle it themselves). */
const ESCAPE_GOES_BACK = new Set<KeyContext>(['settings', 'search', 'skipped', 'spam']);

const toolbarButton = 'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded px-2 text-muted hover:bg-hover hover:text-fg';

/** The header search: Enter runs a Gmail search across every account; `/` focuses it from anywhere. */
function HeaderSearch({ inputRef }: { inputRef: RefObject<HTMLInputElement> }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <form
      role="search"
      className="relative hidden w-56 shrink-0 md:block lg:w-64"
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
        setQ('');
        inputRef.current?.blur();
      }}
    >
      <Search size={14} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
      <input
        ref={inputRef}
        type="text"
        enterKeyHint="search"
        aria-label="Search mail"
        placeholder="Search mail"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          // Escape leaves the field instead of leaving the page.
          if (e.key === 'Escape') {
            e.preventDefault();
            setQ('');
            e.currentTarget.blur();
          }
        }}
        className="h-8 w-full rounded border border-line bg-panel pl-8 pr-8 text-sm text-fg placeholder:text-faint hover:border-faint focus:border-accent focus:bg-bg"
      />
      {q === '' && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          <Kbd k="/" />
        </span>
      )}
    </form>
  );
}

/**
 * The computer layout (mockup option B): a header with Back, the view's own controls (`top`: the
 * account switcher), search, Compose and the main pages; the view's sub-header row (`sub`: the group
 * tabs), full width under it; the main area; and the shortcut
 * panel on the right for the current key context. The header owns `/` (search), `c` (compose)
 * and, on the simple pages, Escape (back). `noBack` is for a screen with a Back of its own.
 *
 * A phone gets the app bar instead, with `phoneBar` in place of its usual contents, and no shortcut panel.
 */
export function Layout({ context, top, sub, noBack = false, phoneBar, children }: { context: KeyContext; top?: ReactNode; sub?: ReactNode; noBack?: boolean; phoneBar?: ReactNode; children: ReactNode }) {
  const phone = useIsPhone();
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  // The search page has its own, larger field.
  const showSearch = !pathname.startsWith('/search');

  // Back goes to the previous screen when there is one inside the app, otherwise to the inbox.
  const back = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/');
  };

  useShortcuts(context, {
    compose: () => navigate('/compose'),
    ...(showSearch ? { search: () => searchRef.current?.focus() } : {}),
    ...(ESCAPE_GOES_BACK.has(context) ? { back } : {}),
  });

  return (
    <div className="flex h-dvh flex-col md:h-full">
      {phone ? (
        <AppBar context={context} top={top} bar={phoneBar} onBack={pathname !== '/' && !noBack ? back : undefined} />
      ) : (
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        {pathname !== '/' && !noBack && (
          <button type="button" onClick={back} title="Back (Esc)" className={`${toolbarButton} -ml-2`}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            <span className="sr-only sm:not-sr-only">Back</span>
          </button>
        )}
        <span className="sr-only shrink-0 font-semibold sm:not-sr-only">SuperMail</span>
        <div className="flex min-w-0 flex-1 items-center gap-4">{top}</div>
        {showSearch && (
          <>
            <HeaderSearch inputRef={searchRef} />
            <Link to="/search" aria-label="Search" title="Search (/)" className={`${toolbarButton} w-8 justify-center md:hidden`}>
              <Search size={16} strokeWidth={1.75} aria-hidden />
            </Link>
          </>
        )}
        <Link
          to="/compose"
          title="Compose (c)"
          className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded bg-accent px-3 font-medium text-on-accent hover:opacity-90"
        >
          <Pencil size={16} strokeWidth={1.75} aria-hidden />
          <span className="sr-only sm:not-sr-only">Compose</span>
          <span className="hidden lg:inline-flex">
            <Kbd k="c" />
          </span>
        </Link>
        <nav aria-label="Main" className="flex shrink-0 items-center gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              aria-label={n.label}
              title={n.title}
              className={({ isActive }) => `${toolbarButton} text-xs ${isActive ? 'bg-hover font-semibold text-fg' : ''}`}
            >
              <n.icon size={16} strokeWidth={1.75} aria-hidden />
              <span className="hidden xl:inline">{n.label}</span>
            </NavLink>
          ))}
        </nav>
      </header>
      )}
      {sub && (
        <div data-testid="subheader" className="flex h-[49px] shrink-0 items-stretch border-b border-line md:h-9 md:px-4">
          {sub}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        {!phone && <ShortcutPanel context={context} />}
      </div>
    </div>
  );
}
