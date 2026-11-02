import { ArrowLeft, Archive, CheckCheck, EllipsisVertical, OctagonAlert, Search, Settings, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { KeyContext } from '../../keys/keymap';
import { useShowDone } from '../../state/ui';
import { BottomSheet } from '../BottomSheet';
import { whenBackSettled } from './backStack';

export const barButton = 'inline-flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted active:bg-hover';

const sheetRow = 'flex min-h-12 w-full touch-manipulation items-center gap-4 px-4 text-left text-base active:bg-hover';

const TITLES: Partial<Record<KeyContext, string>> = { skipped: 'Skipped', spam: 'Spam', settings: 'Settings' };

const PAGES: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/skipped', label: 'Skipped', icon: Archive },
  { to: '/spam', label: 'Spam', icon: OctagonAlert },
];

function MoreSheet({ context, onClose }: { context: KeyContext; onClose(): void }) {
  const navigate = useNavigate();
  const [showDone, setShowDone] = useShowDone();
  const page = ({ to, label, icon: Icon }: (typeof PAGES)[number]) => (
    <Link
      key={to}
      to={to}
      className={sheetRow}
      onClick={(e) => {
        e.preventDefault();
        onClose();
        whenBackSettled(() => navigate(to));
      }}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
      {label}
    </Link>
  );
  return (
    <BottomSheet label="More" hideTitle onClose={onClose}>
      <div className="pb-1">
        {PAGES.map(page)}
        {context === 'list' && (
          <button type="button" role="switch" aria-checked={showDone} onClick={() => setShowDone(!showDone)} className={sheetRow}>
            <CheckCheck size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
            <span className="flex-1">Show done</span>
            <span aria-hidden className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150 ease-out ${showDone ? 'bg-accent' : 'bg-line'}`}>
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-bg transition-transform duration-150 ease-out ${showDone ? 'translate-x-4' : ''}`} />
            </span>
          </button>
        )}
        {page({ to: '/settings', label: 'Settings', icon: Settings })}
      </div>
    </BottomSheet>
  );
}

export interface AppBarProps {
  context: KeyContext;
  /** The account control on the inbox. */
  top?: ReactNode;
  /** Takes the bar over, keeping Back: the search field while searching. */
  bar?: ReactNode;
  onBack?(): void;
}

/** The phone's 56px bar: Back or the account, then Search and the More sheet. A screen with no `top` shows its title. */
export function AppBar({ context, top, bar, onBack }: AppBarProps) {
  const [more, setMore] = useState(false);
  return (
    <header className="shrink-0 border-b border-line bg-bg pt-[env(safe-area-inset-top)]">
      <div data-testid="app-bar-row" className="flex h-14 items-center gap-2 px-2">
        {onBack && (
          <button type="button" aria-label="Back" onClick={onBack} className={barButton}>
            <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {bar ?? (
          <>
            <div className="flex min-w-0 flex-1 items-center">{top ?? (TITLES[context] && <span className="truncate pl-2 text-lg font-semibold">{TITLES[context]}</span>)}</div>
            <Link to="/search" aria-label="Search" className={barButton}>
              <Search size={20} strokeWidth={1.75} aria-hidden />
            </Link>
            <button type="button" aria-label="More" aria-haspopup="dialog" onClick={() => setMore(true)} className={barButton}>
              <EllipsisVertical size={20} strokeWidth={1.75} aria-hidden />
            </button>
          </>
        )}
      </div>
      {more && <MoreSheet context={context} onClose={() => setMore(false)} />}
    </header>
  );
}
