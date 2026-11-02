import { offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { accountTag } from '../lib/accounts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ExternalLink, Inbox as InboxIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountDTO, FilterDTO, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { CommandPalette } from '../components/CommandPalette';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { RowSheet, threadSheetItems } from '../components/phone/RowSheet';
import { useThreadActions, useThreadMenu } from '../components/ThreadContextMenu';
import { ThreadListbox } from '../components/ThreadList';
import { rowDomId, threadHref, ThreadRow } from '../components/ThreadRow';
import { UndoToast } from '../components/UndoToast';
import { useShortcuts } from '../keys/useShortcuts';
import { useIsPhone } from '../lib/useIsPhone';
import type { ComposeMode, ThreadNavState } from './Thread';

// "Skipped your inbox" (spec §4.9): recent mail that never reached the inbox (Superhuman's auto
// archive, Gmail filters), with one key to bring it back, and the Gmail filters that hide mail.

const HIDES: Record<FilterDTO['hides'][number], string> = {
  skip_inbox: 'Skips inbox',
  trash: 'Deletes',
  mark_read: 'Marks read',
};

function FiltersTable({ accounts }: { accounts: AccountDTO[] }) {
  const filters = useQuery({ queryKey: qk.filters(), queryFn: api.filters });
  const email = (id: string) => accounts.find((a) => a.id === id)?.email ?? id;
  return (
    <section aria-labelledby="filters-heading" className="px-4 py-6">
      <h2 id="filters-heading" className="mb-1 text-sm font-semibold">Filters that hide mail</h2>
      <p className="mb-3 text-xs text-muted">
        These Gmail filters archive, delete or mark mail as read before you see it. SuperMail can't change filters; open Gmail's
        filter settings to keep or delete each one.
      </p>
      {filters.isPending ? (
        <p className="text-xs text-muted">Loading filters…</p>
      ) : filters.isError ? (
        <p role="alert" className="text-xs text-danger">Couldn't load filters: {filters.error.message}</p>
      ) : filters.data.length === 0 ? (
        <p className="text-xs text-muted">No Gmail filters hide mail.</p>
      ) : (
        <table aria-labelledby="filters-heading" className="block w-full border-collapse text-left text-xs md:table">
          <thead className="hidden text-2xs uppercase tracking-wider text-faint md:table-header-group">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-semibold">Account</th>
              <th className="py-2 pr-3 font-semibold">Matches</th>
              <th className="py-2 pr-3 font-semibold">Does</th>
              <th className="py-2 font-semibold">
                <span className="sr-only">Gmail</span>
              </th>
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {filters.data.map((f) => (
              <tr key={`${f.accountId}/${f.filterId}`} className="block border-b border-line py-2 md:table-row md:py-0">
                <td className="block py-0.5 pr-3 text-muted md:table-cell md:py-2">{email(f.accountId)}</td>
                <td className="block break-all py-0.5 pr-3 font-mono text-xs md:table-cell md:break-normal md:py-2">{f.criteria}</td>
                <td className="block py-0.5 pr-3 md:table-cell md:py-2">
                  <span className="flex flex-wrap gap-1">
                    {f.hides.map((h) => (
                      <span key={h} data-hides={h} className="rounded bg-warn-bg px-1 text-2xs font-semibold text-fg">
                        {HIDES[h]}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="block md:table-cell md:py-2 md:text-right">
                  <a
                    href={f.gmailSettingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-11 cursor-pointer touch-manipulation items-center gap-1 whitespace-nowrap text-accent hover:underline md:h-6"
                  >
                    Open in Gmail
                    <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface Toast { key: number; message: string; tone?: 'info' | 'error'; undoId?: string }

/** Works like the inbox list: one click opens, `i` restores, `z` undoes, Escape goes back. */
export function Skipped() {
  const phone = useIsPhone();
  const [pressed, setPressed] = useState<ThreadSummaryDTO | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const skipped = useQuery({ queryKey: qk.skipped(), queryFn: api.skipped });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const [index, setIndex] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastSeq = useRef(0);
  const showToast = (t: Omit<Toast, 'key'>) => setToast({ ...t, key: ++toastSeq.current });

  const threads = skipped.data?.threads ?? [];
  const sel = Math.min(index, Math.max(threads.length - 1, 0));
  const selected = threads[sel];
  const subjectOf = (t: ThreadSummaryDTO) => t.subject || '(no subject)';

  const restore = useMutation({
    mutationFn: (t: ThreadSummaryDTO) => api.restore(t.id),
    onMutate: async (t) => {
      await qc.cancelQueries({ queryKey: qk.skipped() });
      const before = qc.getQueryData<ThreadPage>(qk.skipped());
      if (before) qc.setQueryData<ThreadPage>(qk.skipped(), { ...before, threads: before.threads.filter((x) => x.id !== t.id) });
      return { before };
    },
    onError: (_err, t, ctx) => {
      if (ctx?.before) {
        // put the row back without dropping other restores that succeeded meanwhile
        const now = qc.getQueryData<ThreadPage>(qk.skipped());
        const keep = new Set((now?.threads ?? []).map((x) => x.id));
        keep.add(t.id);
        qc.setQueryData<ThreadPage>(qk.skipped(), { ...ctx.before, threads: ctx.before.threads.filter((x) => keep.has(x.id)) });
      }
      showToast({ message: `Couldn't restore "${subjectOf(t)}". Try again.`, tone: 'error' });
    },
    onSuccess: (res, t) => {
      showToast({ message: `Restored "${subjectOf(t)}" to the inbox`, undoId: res.undoId });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });

  const undoRestore = useMutation({
    mutationFn: (undoId: string) => api.undo(undoId),
    onSuccess: () => {
      showToast({ message: 'Undone' });
      for (const key of [qk.skipped(), ['threads'], ['groups']]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => showToast({ message: `Couldn't undo: ${err.message}`, tone: 'error' }),
  });
  const undoLast = () => {
    if (!toast?.undoId) return;
    const undoId = toast.undoId;
    setToast({ ...toast, undoId: undefined });
    undoRestore.mutate(undoId);
  };

  const open = (t: ThreadSummaryDTO | undefined, compose?: ComposeMode) => {
    if (!t) return;
    const state: ThreadNavState = { ids: threads.map((x) => x.id), compose };
    navigate(threadHref(t.id), { state });
  };
  const move = (delta: 1 | -1) => setIndex((i) => Math.max(0, Math.min(Math.min(i, threads.length - 1) + delta, threads.length - 1)));

  // Escape (back), `/` and `c` are the header's (Layout).
  useShortcuts('skipped', {
    next: () => move(1),
    prev: () => move(-1),
    open: () => open(selected),
    restore: () => selected && restore.mutate(selected),
    undo: undoLast,
  });

  // The menu's actions speak through this screen's toast, so `z` undoes them like a restore.
  const notify = (message: string, opts: { tone?: 'info' | 'error'; undoId?: string } = {}) => showToast({ message, ...opts });
  const { actions, pickers, pickerOpen } = useThreadActions({ notify, moveToInbox: (t) => restore.mutate(t) });
  const menu = useThreadMenu({ context: 'skipped', selected, disabled: pickerOpen, open, actions, notify });

  const accountColor = (id: string) => accounts.data?.find((a) => a.id === id)?.color ?? 'var(--faint)';

  return (
    <Layout context="skipped">
      <div className="border-b border-line px-4 py-3">
        {phone ? (
          <p className="text-sm text-muted">Mail from the last 30 days that went straight to the archive. Swipe right to put it back in the inbox.</p>
        ) : (
          <>
            <h1 className="text-base font-semibold">Skipped your inbox</h1>
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
              Mail from the last 30 days that went straight to the archive. Press <Kbd k="i" /> to put it back in the inbox.
            </p>
          </>
        )}
      </div>

      {waitingForNetwork(skipped) ? (
        <p role="alert" className="px-4 py-3 text-muted">
          {offline('skipped mail')} <RetryButton onRetry={() => void skipped.refetch()} />
        </p>
      ) : skipped.isPending ? (
        <p className="px-4 py-3 text-xs text-muted">Loading…</p>
      ) : skipped.isError ? (
        <p role="alert" className="px-4 py-3 text-xs text-danger">
          Couldn't load skipped mail: {skipped.error.message}
          {phone && (
            <>
              {' '}
              <button type="button" className="inline-flex h-11 touch-manipulation items-center text-accent underline" onClick={() => void skipped.refetch()}>
                Retry
              </button>
            </>
          )}
        </p>
      ) : threads.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted">Nothing skipped your inbox in the last 30 days.</p>
      ) : (
        <ThreadListbox
          label="Skipped threads"
          activeId={selected ? rowDomId(selected.id) : undefined}
          onMove={move}
          onMoveTo={(edge) => setIndex(edge === 'first' ? 0 : threads.length - 1)}
        >
          {threads.map((t, i) => (
            <ThreadRow
              key={t.id}
              thread={t}
              accountColor={accountColor(t.accountId)}
              account={accountTag(accounts.data, t.accountId)}
              selected={i === sel}
              onSelect={() => setIndex(i)}
              onOpen={() => open(t)}
              onMenu={(x, y) => menu.openAt(t, x, y)}
              onLongPress={() => setPressed(t)}
              swipe={{ right: { label: 'Restore', icon: InboxIcon, tone: 'done', onCommit: () => restore.mutate(t) } }}
              actions={[{ label: 'Restore to inbox', keyHint: 'i', icon: ArchiveRestore, run: () => restore.mutate(t) }]}
            />
          ))}
        </ThreadListbox>
      )}

      <FiltersTable accounts={accounts.data ?? []} />
      {menu.menu}
      {pressed && <RowSheet thread={pressed} items={threadSheetItems(pressed, { open, actions })} onClose={() => setPressed(null)} />}
      {pickers}
      <CommandPalette context="skipped" />
      {toast && (
        <UndoToast
          key={toast.key}
          message={toast.message}
          tone={toast.tone}
          onUndo={toast.undoId ? undoLast : undefined}
          onClose={() => setToast((cur) => (cur?.key === toast.key ? null : cur))}
        />
      )}
    </Layout>
  );
}
