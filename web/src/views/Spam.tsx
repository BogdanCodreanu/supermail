import { offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Inbox as InboxIcon, MailOpen } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ThreadId, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { applyServerEvent } from '../api/events';
import { CommandPalette } from '../components/CommandPalette';
import { Layout } from '../components/Layout';
import { RowSheet } from '../components/phone/RowSheet';
import { copyLink, hint, useRowMenu } from '../components/ThreadContextMenu';
import { ThreadListbox } from '../components/ThreadList';
import { rowDomId, spamHref, ThreadRow } from '../components/ThreadRow';
import { useShortcuts } from '../keys/useShortcuts';
import { accountTag } from '../lib/accounts';
import { showToast, useUndoLast } from '../state/toasts';

/**
 * Not spam, from the list or the reader: the row leaves the list at once and comes back if Gmail refuses.
 * The toast is the app's, so `z` still undoes it on the next screen.
 */
export function useNotSpam(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ThreadId) => api.notSpam(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.spam() });
      const before = qc.getQueryData<ThreadPage>(qk.spam());
      if (before) qc.setQueryData<ThreadPage>(qk.spam(), { ...before, threads: before.threads.filter((t) => t.id !== id) });
      return { row: before?.threads.find((t) => t.id === id) };
    },
    onError: (err, _id, ctx) => {
      // Only this row: others may have left the list meanwhile.
      const now = qc.getQueryData<ThreadPage>(qk.spam());
      if (ctx?.row && now) qc.setQueryData<ThreadPage>(qk.spam(), { ...now, threads: [...now.threads, ctx.row].sort((a, b) => b.lastMessageAt - a.lastMessageAt) });
      showToast(`Couldn't move it to the inbox: ${err.message}`, { tone: 'error' });
    },
    onSuccess: (res) => {
      if (res.thread) applyServerEvent(qc, { type: 'thread.updated', thread: res.thread });
      showToast('Not spam. Moved to the inbox', { undoId: res.undoId });
      onDone?.();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

function SpamSkeleton() {
  const bar = 'rounded bg-hover';
  return (
    <div role="status" aria-busy="true" aria-label="Loading spam">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden className="flex h-9 items-center gap-3 border-b border-line px-4">
          <span className={`${bar} h-2 w-2 shrink-0 rounded-full`} />
          <span className={`${bar} h-3 w-32 shrink-0`} />
          <span className={`${bar} h-3 flex-1`} style={{ maxWidth: `${40 + ((i * 17) % 45)}%` }} />
          <span className="flex-1" />
          <span className={`${bar} h-3 w-10 shrink-0`} />
        </div>
      ))}
    </div>
  );
}

/** `/spam`: Gmail's spam in every account, read live. One click opens, `i` is Not spam, `z` undoes, Escape goes back. */
export function Spam() {
  const [pressed, setPressed] = useState<ThreadSummaryDTO | null>(null);
  const navigate = useNavigate();
  const spam = useQuery({ queryKey: qk.spam(), queryFn: ({ signal }) => api.spam(signal) });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const notSpam = useNotSpam();
  const undo = useUndoLast();
  const [index, setIndex] = useState(0);

  const threads = spam.data?.threads ?? [];
  const sel = Math.min(index, Math.max(threads.length - 1, 0));
  const selected = threads[sel];
  const open = (t: ThreadSummaryDTO) => navigate(spamHref(t.id));
  const move = (delta: 1 | -1) => setIndex(Math.max(0, Math.min(sel + delta, threads.length - 1)));

  // Escape (back), `/` and `c` are the header's (Layout).
  useShortcuts('spam', {
    next: () => move(1),
    prev: () => move(-1),
    open: () => selected && open(selected),
    notSpam: () => selected && notSpam.mutate(selected.id),
    undo,
  });

  const menu = useRowMenu({
    selected,
    items: (t) => [
      { id: 'open', label: 'Open', icon: MailOpen, keyHint: hint('open', 'spam'), onSelect: () => open(t) },
      { id: 'notSpam', label: 'Not spam', icon: InboxIcon, keyHint: hint('notSpam', 'spam'), onSelect: () => notSpam.mutate(t.id) },
      'separator',
      { id: 'copy', label: 'Copy link', icon: Copy, onSelect: () => copyLink(spamHref(t.id), showToast) },
    ],
  });

  const accountColor = (id: string) => accounts.data?.find((a) => a.id === id)?.color ?? 'var(--faint)';

  return (
    <Layout context="spam">
      <div className="border-b border-line px-4 py-3">
        <h1 className="hidden text-base font-semibold md:block">Spam</h1>
        <p className="text-xs text-muted md:mt-1">Gmail keeps spam for 30 days, then deletes it.</p>
      </div>

      {waitingForNetwork(spam) ? (
        <p role="alert" className="px-4 py-3 text-muted">
          {offline('spam')} <RetryButton onRetry={() => void spam.refetch()} />
        </p>
      ) : spam.isPending ? (
        <SpamSkeleton />
      ) : !spam.data ? (
        <p role="alert" className="px-4 py-3 text-xs text-danger">
          Couldn't load spam: {spam.error?.message}{' '}
          <button type="button" className="cursor-pointer text-accent underline" onClick={() => void spam.refetch()}>
            Retry
          </button>
        </p>
      ) : threads.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted">No spam. Nice.</p>
      ) : (
        <ThreadListbox
          label="Spam threads"
          activeId={selected ? rowDomId(selected.id) : undefined}
          onMove={move}
          onMoveTo={(edge) => setIndex(edge === 'first' ? 0 : threads.length - 1)}
        >
          {threads.map((t, i) => (
            <ThreadRow
              key={t.id}
              thread={t}
              href={spamHref(t.id)}
              accountColor={accountColor(t.accountId)}
              account={accountTag(accounts.data, t.accountId)}
              selected={i === sel}
              onSelect={() => setIndex(i)}
              onOpen={() => open(t)}
              onMenu={(x, y) => menu.openAt(t, x, y)}
              onLongPress={() => setPressed(t)}
              swipe={{ right: { label: 'Not spam', icon: InboxIcon, tone: 'done', onCommit: () => notSpam.mutate(t.id) } }}
              actions={[{ label: 'Not spam', keyHint: 'i', icon: InboxIcon, run: () => notSpam.mutate(t.id) }]}
            />
          ))}
        </ThreadListbox>
      )}

      {menu.menu}
      {pressed && (
        <RowSheet
          thread={pressed}
          items={[
            { id: 'open', label: 'Open', icon: MailOpen, navigates: true, run: () => open(pressed) },
            { id: 'notSpam', label: 'Not spam', icon: InboxIcon, run: () => notSpam.mutate(pressed.id) },
          ]}
          onClose={() => setPressed(null)}
        />
      )}
      <CommandPalette context="spam" />
    </Layout>
  );
}
