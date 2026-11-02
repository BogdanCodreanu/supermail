import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Inbox as InboxIcon, Paperclip, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { MessageDTO } from '@supermail/shared';
import { api, ApiError, qk } from '../api/client';
import { CommandPalette } from '../components/CommandPalette';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { loadFailure, offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { MessageBody } from '../components/MessageBody';
import { CollapsedHeader, ExpandedHeader } from '../components/MessageHeader';
import { ReaderScreen } from '../components/phone/ReaderScreen';
import { BarButton, ToolButton } from '../components/ThreadToolbar';
import { useShortcuts } from '../keys/useShortcuts';
import { previewOf } from '../lib/quotes';
import { useIsPhone } from '../lib/useIsPhone';
import { useUndoLast } from '../state/toasts';
import { useNotSpam } from './Spam';
import { AccountDot } from './Thread';

/** Names only: there is no way to open a spam attachment here, and the server has no route that would serve one. */
function AttachmentNames({ m }: { m: MessageDTO }) {
  return (
    <ul className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap" aria-label="Attachments">
      {m.attachments.map((a) => (
        <li key={a.attachmentId} className="flex h-12 items-center gap-1.5 rounded border border-line px-3 text-sm text-muted md:inline-flex md:h-7 md:px-2 md:text-xs">
          <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" className="h-5 w-5 shrink-0 text-faint md:h-3.5 md:w-3.5" />
          <span className="min-w-0 truncate md:max-w-60">{a.filename || 'attachment'}</span>
        </li>
      ))}
    </ul>
  );
}

function ReaderSkeleton() {
  const bar = 'rounded bg-hover';
  return (
    <div role="status" aria-busy="true" aria-label="Loading this email" className="mx-auto max-w-4xl px-4 pt-4">
      <div aria-hidden className="flex flex-col gap-3">
        <span className={`${bar} h-5 w-2/3`} />
        <span className={`${bar} h-3 w-40`} />
        <span className={`${bar} mt-4 h-32 w-full`} />
      </div>
    </div>
  );
}

/**
 * `/spam/:id`: one spam thread, read live from Gmail and read-only. Nothing remote loads, attachments are only
 * named, nothing is marked read, and the one action is Not spam.
 */
export function SpamThread() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const detail = useQuery({ queryKey: qk.spamThread(id), queryFn: () => api.spamThread(id), gcTime: 0 });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const phone = useIsPhone();

  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/spam');
  };
  const notSpam = useNotSpam(goBack);
  const busy = useRef(false);
  const rescue = () => {
    if (!detail.data || busy.current) return;
    busy.current = true;
    notSpam.mutate(id, { onSettled: () => void (busy.current = false) });
  };
  const undo = useUndoLast();
  useShortcuts('spamReader', { back: goBack, notSpam: rescue, undo });

  let body;
  if (waitingForNetwork(detail)) {
    body = (
      <p role="alert" className="p-6 text-muted">
        {offline('this email')} <RetryButton onRetry={() => void detail.refetch()} />
      </p>
    );
  } else if (detail.isPending) {
    body = <ReaderSkeleton />;
  } else if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.status === 404;
    body = gone ? (
      <p className="p-6 text-muted">This email is no longer in spam.</p>
    ) : (
      <p role="alert" className="p-6 text-danger">
        {loadFailure('this email', detail.error)} <RetryButton onRetry={() => void detail.refetch()} />
      </p>
    );
  } else {
    const { thread: t, messages } = detail.data;
    const account = accounts.data?.find((a) => a.id === t.accountId);
    body = (
      <div className="mx-auto max-w-4xl pb-8 pt-4">
        <header className="px-4 pb-4">
          <h1 className="text-lg font-semibold">{t.subject || '(no subject)'}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded bg-hover px-2 py-0.5 text-muted">
              <AccountDot account={account} />
              {t.groupName}
            </span>
            <span className="text-faint">{account?.email ?? t.accountId}</span>
          </div>
          <p className="mt-2 flex items-center gap-1.5 rounded bg-warn-bg px-2 py-1 text-xs text-fg">
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            Be careful with links in this email.
          </p>
        </header>
        <div className="border-t border-line">
          {messages.map((m) => {
            const toggle = () => setClosed((c) => ({ ...c, [m.id]: !c[m.id] }));
            return (
              <article key={m.id} className="border-b border-line">
                {closed[m.id] ? (
                  <CollapsedHeader m={m} me={account?.email} preview={previewOf(m)} onToggle={toggle} />
                ) : (
                  <>
                    <ExpandedHeader m={m} me={account?.email} account={account?.email ?? t.accountId} onToggle={toggle} />
                    <div className="px-4 pb-4 pt-2">
                      <MessageBody message={m} blockRemote />
                      {m.attachments.length > 0 && <AttachmentNames m={m} />}
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  if (phone) {
    return (
      <ReaderScreen
        title={detail.data ? detail.data.thread.subject || '(no subject)' : ''}
        screenKey={id}
        onBack={goBack}
        bar={detail.data && <BarButton icon={InboxIcon} label="Not spam" onClick={rescue} />}
        barLabel="Spam actions"
      >
        {body}
      </ReaderScreen>
    );
  }

  return (
    <Layout context="spamReader" noBack>
      <div role="toolbar" aria-label="Spam actions" className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex h-11 max-w-4xl items-center gap-2 px-2">
          <ToolButton icon={ArrowLeft} label="Back" keyHint="Esc" onClick={goBack} />
          <button
            type="button"
            onClick={rescue}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded border border-line px-3 text-sm transition-colors duration-150 ease-out hover:bg-hover"
          >
            <InboxIcon size={16} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
            Not spam
            <Kbd k="i" />
          </button>
        </div>
      </div>
      {body}
      <CommandPalette context="spamReader" />
    </Layout>
  );
}
