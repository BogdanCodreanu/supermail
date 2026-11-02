import { offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { accountTag } from '../lib/accounts';
import { useQuery } from '@tanstack/react-query';
import { Check, Clock, Inbox as InboxIcon, Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { CommandPalette } from '../components/CommandPalette';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { barButton } from '../components/phone/AppBar';
import { RowSheet, threadSheetItems } from '../components/phone/RowSheet';
import { useThreadActions, useThreadMenu } from '../components/ThreadContextMenu';
import { ThreadListbox } from '../components/ThreadList';
import { rowDomId, threadHref, ThreadRow } from '../components/ThreadRow';
import { useShortcuts } from '../keys/useShortcuts';
import { useIsPhone } from '../lib/useIsPhone';
import type { ComposeMode, ThreadNavState } from './Thread';

/** `/search?q=`: Gmail search across every account (full history), results merged newest first. */
export function Search() {
  const phone = useIsPhone();
  const [pressed, setPressed] = useState<ThreadSummaryDTO | null>(null);
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const [input, setInput] = useState(q);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const results = useQuery({ queryKey: qk.search(q), queryFn: () => api.search(q), enabled: q !== '' });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const threads = results.data?.threads ?? [];
  const current = threads[Math.min(selected, threads.length - 1)];

  useEffect(() => {
    setInput(q);
    setSelected(0);
    if (!q) inputRef.current?.focus();
  }, [q]);

  const open = (t: ThreadSummaryDTO | undefined, compose?: ComposeMode) => {
    if (!t) return;
    const state: ThreadNavState = { ids: threads.map((x) => x.id), compose };
    navigate(threadHref(t.id), { state });
  };
  const move = (delta: 1 | -1) => setSelected((s) => Math.max(0, Math.min(s + delta, threads.length - 1)));

  // Escape (back) and `c` are the header's (Layout); `/` here goes to this page's own field.
  useShortcuts('search', {
    next: () => move(1),
    prev: () => move(-1),
    open: () => open(current),
    search: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });

  const { actions, pickers, pickerOpen } = useThreadActions();
  const menu = useThreadMenu({ context: 'search', selected: current, disabled: pickerOpen, open, actions });

  const submit = () => {
    const next = input.trim();
    if (next) setParams({ q: next });
    inputRef.current?.blur();
  };

  // The app bar is the search field on a phone: 16px, or Android zooms the page when it takes focus.
  const phoneBar = (
    <form
      role="search"
      className="relative flex min-w-0 flex-1 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        aria-label="Search mail"
        placeholder="Search mail"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="h-11 w-full min-w-0 appearance-none bg-transparent pr-11 text-[16px] placeholder:text-faint focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {input !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setInput('');
            inputRef.current?.focus();
          }}
          className={`${barButton} absolute right-0 top-0`}
        >
          <X size={20} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </form>
  );

  return (
    <Layout context="search" phoneBar={phoneBar}>
      <div className="mx-auto max-w-5xl md:py-3">
        {!phone && (
        <form
          role="search"
          className="relative mx-4 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <SearchIcon size={16} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            type="text"
            enterKeyHint="search"
            aria-label="Search mail"
            placeholder="Search all accounts (Gmail search: from:, subject:, has:attachment …)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Escape leaves the field; a second Escape goes back.
              if (e.key === 'Escape') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className="h-10 w-full rounded border border-line bg-bg pl-10 pr-10 text-base placeholder:text-faint focus:border-accent"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
            <Kbd k="Enter" />
          </span>
        </form>
        )}
        {q === '' ? (
          <p className="p-4 text-muted md:p-0 md:px-4">{phone ? 'Search every account.' : 'Type a search and press Enter.'}</p>
        ) : waitingForNetwork(results) ? (
          <p role="alert" className="p-4 text-muted md:p-0 md:px-4">
          {offline('search results')} <RetryButton onRetry={() => void results.refetch()} />
        </p>
        ) : results.isPending ? (
          <p className="p-4 text-muted md:p-0 md:px-4">Searching…</p>
        ) : results.isError ? (
          <p role="alert" className="p-4 text-muted md:p-0 md:px-4">
            Search failed: {results.error.message}
            {phone && (
              <>
                {' '}
                <button type="button" className="inline-flex h-11 touch-manipulation items-center text-accent underline" onClick={() => void results.refetch()}>
                  Retry
                </button>
              </>
            )}
          </p>
        ) : threads.length === 0 ? (
          <p className="p-4 text-muted md:p-0 md:px-4">No mail matches “{q}”.</p>
        ) : (
          <ThreadListbox
            label="Search results"
            activeId={current ? rowDomId(current.id) : undefined}
            onMove={move}
            onMoveTo={(edge) => setSelected(edge === 'first' ? 0 : threads.length - 1)}
            className="md:border-t md:border-line"
          >
            {threads.map((t, i) => (
              <ThreadRow
                key={t.id}
                thread={t}
                accountColor={accounts.data?.find((a) => a.id === t.accountId)?.color ?? 'var(--faint)'}
                account={accountTag(accounts.data, t.accountId)}
                chip={t.inInbox ? { label: t.groupName, title: t.reason.text } : { label: 'Archived', title: 'Not in the inbox' }}
                selected={t === current}
                onSelect={() => setSelected(i)}
                onOpen={() => open(t)}
                onMenu={(x, y) => menu.openAt(t, x, y)}
                onLongPress={() => setPressed(t)}
                swipe={{
                  right: t.inInbox
                    ? { label: 'Done', icon: Check, tone: 'done', onCommit: () => actions.done(t) }
                    : { label: 'Inbox', icon: InboxIcon, tone: 'done', onCommit: () => actions.moveToInbox(t) },
                  left: { label: 'Snooze', icon: Clock, tone: 'snooze', stays: true, onCommit: () => actions.pickSnooze(t) },
                }}
              />
            ))}
          </ThreadListbox>
        )}
      </div>
      {menu.menu}
      {pressed && <RowSheet thread={pressed} items={threadSheetItems(pressed, { open, actions })} onClose={() => setPressed(null)} />}
      {pickers}
      <CommandPalette context="search" />
    </Layout>
  );
}
