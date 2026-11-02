import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bell, BellOff, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountDTO, AccountStatus, CreateGroupRequest, GroupDTO, PushDeviceDTO, StorageUsageDTO, TeachingDTO } from '@supermail/shared';
import { api, qk, type GroupPatch } from '../api/client';
import { CommandPalette } from '../components/CommandPalette';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { loadFailure, offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { UndoToast } from '../components/UndoToast';
import { sendTestPush } from '../lib/push';
import { useIsPhone } from '../lib/useIsPhone';
import { usePushStatus, useTurnOffPush, useTurnOnPush } from '../lib/usePush';

// Settings: notifications on this device, accounts (connect, reconnect, remove), groups (rename, reorder, color, notify, custom
// and Gmail-label groups), what the owner has taught, and storage usage against the hard limits
// (spec §4.1–4.3).

const STATUS: Record<AccountStatus, string> = { ok: 'Connected', syncing: 'Syncing…', reconnect_needed: 'Reconnect needed' };
const NEW_GROUP_COLOR = '#64748b';

const button =
  'inline-flex h-11 shrink-0 cursor-pointer items-center rounded border border-line px-3 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent max-md:active:bg-hover md:h-6 md:px-2 md:text-xs';
const danger = 'inline-flex h-11 shrink-0 cursor-pointer items-center rounded border border-danger px-3 text-sm text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-40 max-md:active:bg-danger-bg md:h-6 md:px-2 md:text-xs';
const primary = 'inline-flex h-11 shrink-0 cursor-pointer items-center rounded bg-accent px-3 text-sm font-medium text-on-accent hover:opacity-90 max-md:active:opacity-80 md:h-6 md:px-2 md:text-xs';
const primaryLarge = 'inline-flex h-11 shrink-0 cursor-pointer items-center rounded bg-accent px-3 text-sm font-medium text-on-accent hover:opacity-90 max-md:active:opacity-80 md:h-8 md:text-xs';
const iconButton = 'inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent max-md:active:bg-hover md:h-6 md:w-6';
/** A native color swatch, with the phone's touch target. */
const colorInput = 'h-11 w-11 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0 md:h-6 md:w-6';

function Section({ id, title, children, actions }: { id: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-line bg-panel p-4 md:rounded-none md:border-0 md:border-b md:bg-transparent md:px-4 md:py-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 md:flex-nowrap">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 text-xs text-danger">
      {error.message}
    </p>
  );
}

interface SectionQuery { isPending: boolean; fetchStatus: string; error: Error | null; refetch(): unknown }

/** A section that didn't load, with the way out of that. */
function LoadError({ what, query }: { what: string; query: SectionQuery }) {
  if (!query.error) return null;
  return (
    <p role="alert" className="mt-2 text-xs text-danger">
      {loadFailure(what, query.error)} <RetryButton onRetry={() => void query.refetch()} />
    </p>
  );
}

/** "Loading…", unless the phone is offline and it never would be. */
function Loading({ what, query }: { what: string; query: SectionQuery }) {
  if (!waitingForNetwork(query)) return <p className="text-xs text-muted">Loading…</p>;
  return (
    <p role="alert" className="mt-2 text-xs text-danger">
      {offline(what)} <RetryButton onRetry={() => void query.refetch()} />
    </p>
  );
}

// ---------------------------------------------------------------------------------------------

function deviceName(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

const DELIVERED_ON = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function DeviceRow({ device, current, onRemove, removing }: { device: PushDeviceDTO; current: boolean; onRemove: () => void; removing: boolean }) {
  const name = deviceName(device.userAgent);
  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-line py-1 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {name}
          {current && <span className="ml-2 text-2xs text-faint">This device</span>}
        </span>
        <span className="block text-2xs text-faint">{device.lastOkAt ? `Last notified ${DELIVERED_ON.format(device.lastOkAt)}` : 'Not notified yet'}</span>
      </span>
      <button type="button" aria-label={`Remove ${name}`} title="Remove" disabled={removing} onClick={onRemove} className={iconButton}>
        <Trash2 size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

function NotificationsSection() {
  const qc = useQueryClient();
  const status = usePushStatus();
  const turnOn = useTurnOnPush();
  const turnOff = useTurnOffPush();
  const { state, endpoint } = status.data ?? {};
  const usable = !!state && state !== 'unsupported';
  const devices = useQuery({ queryKey: qk.pushDevices(), queryFn: api.pushDevices, enabled: usable });
  const groups = useQuery({ queryKey: qk.groups(), queryFn: () => api.groups(), enabled: usable });
  const patch = useGroupPatch();
  const test = useMutation({ mutationFn: (to: string) => sendTestPush(to), onSettled: () => qc.invalidateQueries({ queryKey: qk.pushDevices() }) });
  const remove = useMutation({
    mutationFn: (d: PushDeviceDTO) => (d.endpoint === endpoint ? turnOff.mutateAsync() : api.removePushDevice(d.id)),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.pushDevices() }),
  });
  const sorted = [...(groups.data ?? [])].sort((a, b) => a.position - b.position);

  return (
    <Section id="settings-notifications" title="Notifications">
      {status.isPending ? (
        <Loading what="notifications" query={status} />
      ) : status.isError ? (
        <LoadError what="notifications" query={status} />
      ) : state === 'unsupported' ? (
        <p className="text-xs text-muted">This browser can't show notifications.</p>
      ) : state === 'blocked' ? (
        <div className="text-xs leading-5 text-muted">
          <p className="font-medium text-fg">Notifications are blocked on this device.</p>
          <p className="mt-1">
            To allow them in Chrome, open the menu, then Settings, Site settings, Notifications, and allow {location.hostname}. In the installed app, hold its icon, then App info,
            Notifications.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-full text-xs text-muted md:basis-0">
            {state === 'on' ? 'On for this device.' : state === 'again' ? 'Notifications stopped on this device and need turning on again.' : 'Off on this device.'}
          </p>
          {state === 'on' ? (
            <>
              <button type="button" className={button} disabled={test.isPending} onClick={() => test.mutate(endpoint!)}>
                Send a test notification
              </button>
              <button type="button" className={button} disabled={turnOff.isPending} onClick={() => turnOff.mutate()}>
                Turn off
              </button>
            </>
          ) : (
            <button type="button" className={primary} disabled={turnOn.isPending} onClick={() => turnOn.mutate()}>
              {turnOn.isPending ? 'Turning on…' : state === 'again' ? 'Turn notifications on again' : 'Turn on'}
            </button>
          )}
        </div>
      )}
      {test.data !== undefined && (
        <p role="status" className="mt-2 text-xs text-muted">
          {test.data ? 'Test sent. It should show up in a few seconds.' : "The test couldn't be delivered."}
        </p>
      )}
      <ErrorLine error={turnOn.error ?? turnOff.error ?? test.error ?? remove.error ?? patch.error} />

      {usable && (devices.data?.length ?? 0) > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-xs font-semibold text-muted">Devices</h3>
          <ul>
            {devices.data!.map((d) => (
              <DeviceRow key={d.id} device={d} current={d.endpoint === endpoint} removing={remove.isPending && remove.variables?.id === d.id} onRemove={() => remove.mutate(d)} />
            ))}
          </ul>
        </>
      )}
      {usable && <LoadError what="your devices" query={devices} />}

      {usable && sorted.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-xs font-semibold text-muted">Groups</h3>
          <p className="mb-1 text-2xs text-faint">Muted groups stay in your inbox, they just don't buzz.</p>
          <ul className="max-w-md">
            {sorted.map((g) => (
              <li key={g.id} className="flex min-h-10 items-center justify-between gap-3 border-b border-line last:border-b-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
                  <span className="truncate">{g.name}</span>
                </span>
                <GroupBell group={g} onToggle={() => patch.mutate({ id: g.id, p: { notify: !g.notify } })} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function AccountRow({ account, onRemove, removing }: { account: AccountDTO; onRemove: () => void; removing: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-3 border-b border-line py-2 last:border-b-0 md:flex-nowrap">
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: account.color }} />
      <span className="min-w-0 flex-1 basis-[calc(100%-20px)] truncate font-medium md:basis-0">{account.email}</span>
      <span className={`mr-auto text-xs md:mr-0 ${account.status === 'reconnect_needed' ? 'rounded bg-warn-bg px-1 font-semibold text-fg' : 'text-muted'}`}>
        {STATUS[account.status]}
      </span>
      {account.status === 'reconnect_needed' && (
        <a href="/auth/connect" className={primary}>
          Reconnect
        </a>
      )}
      {confirming ? (
        <span className="flex flex-wrap items-center gap-2 text-xs md:flex-nowrap">
          <span className="w-full text-muted md:w-auto">Delete its local index, cache and tokens?</span>
          <button type="button" aria-label="Confirm remove" className={danger} disabled={removing} onClick={onRemove}>
            Remove
          </button>
          <button type="button" className={button} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className={button} onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
    </li>
  );
}

function AccountsSection() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeAccount(id),
    onSuccess: () => {
      // its threads and counts go with it
      for (const key of [qk.accounts(), ['groups'], ['threads'], qk.skipped(), qk.filters()]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <Section
      id="settings-accounts"
      title="Accounts"
      actions={
        <a href="/auth/connect" className={primaryLarge}>
          Connect Gmail
        </a>
      }
    >
      {accounts.isPending ? (
        <Loading what="your accounts" query={accounts} />
      ) : accounts.isError ? (
        <LoadError what="your accounts" query={accounts} />
      ) : accounts.data.length === 0 ? (
        <p className="text-xs text-muted">No Gmail accounts connected yet.</p>
      ) : (
        <ul>
          {accounts.data.map((a) => (
            <AccountRow key={a.id} account={a} removing={remove.isPending && remove.variables === a.id} onRemove={() => remove.mutate(a.id)} />
          ))}
        </ul>
      )}
      <ErrorLine error={remove.error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * A color input that saves once the owner has picked: on the input's native `change` (the picker
 * closed) or on blur, never on each step of a drag (React's onChange fires on every `input`).
 */
function ColorInput({ label, value, onCommit }: { label: string; value: string; onCommit: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    setDraft(value);
    saved.current = value;
  }, [value]);
  const commit = (color: string) => {
    if (color === saved.current) return;
    saved.current = color;
    commitRef.current(color);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => commit(el.value);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  return (
    <input
      ref={ref}
      type="color"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      className={colorInput}
    />
  );
}

function GroupBell({ group, onToggle, className = '' }: { group: GroupDTO; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Notify for ${group.name}`}
      aria-pressed={group.notify}
      title={group.notify ? 'Notifications on' : 'Notifications off'}
      onClick={onToggle}
      className={`${iconButton} ${className} ${group.notify ? 'text-fg' : 'text-faint'}`}
    >
      {group.notify ? <Bell size={16} strokeWidth={1.75} aria-hidden /> : <BellOff size={16} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}

/** Changes a group at once on screen and puts it back if the server refuses. */
function useGroupPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, p }: { id: string; p: GroupPatch }) => api.patchGroup(id, p),
    onMutate: ({ id, p }) => {
      const prev = qc.getQueryData<GroupDTO[]>(qk.groups());
      qc.setQueryData<GroupDTO[]>(qk.groups(), (old) => old?.map((x) => (x.id === id ? { ...x, ...p } : x)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(qk.groups(), ctx.prev),
    onSuccess: (g) => qc.setQueryData<GroupDTO[]>(qk.groups(), (old) => old?.map((x) => (x.id === g.id ? { ...x, ...g } : x))),
    onSettled: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

function GroupRow({ group, first, last, onPatch, onMove, onDelete, busy }: {
  group: GroupDTO;
  first: boolean;
  last: boolean;
  onPatch: (p: GroupPatch) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(group.name);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const shown = editing ? name : group.name;

  const commit = () => {
    setEditing(false);
    const next = name.trim();
    if (next && next !== group.name) onPatch({ name: next });
    else setName(group.name);
  };

  return (
    // On the phone: the color and the name on one line, what acts on the group under it.
    <li className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0 md:flex-nowrap md:py-1">
      <span className="order-3 flex gap-2 md:order-none md:gap-0">
        <button type="button" aria-label={`Move ${group.name} up`} title="Move up" disabled={first || busy} onClick={() => onMove(-1)} className={iconButton}>
          <ChevronUp size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" aria-label={`Move ${group.name} down`} title="Move down" disabled={last || busy} onClick={() => onMove(1)} className={iconButton}>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </span>
      <span className="order-1 flex shrink-0 md:order-none">
        <ColorInput label={`Color of ${group.name}`} value={group.color} onCommit={(color) => onPatch({ color })} />
      </span>
      <input
        type="text"
        aria-label={`Name of ${group.name}`}
        value={shown}
        onFocus={() => {
          setName(group.name);
          setEditing(true);
        }}
        onChange={(e) => {
          setEditing(true);
          setName(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setName(group.name);
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className="order-2 h-11 min-w-0 flex-1 basis-[calc(100%-52px)] rounded border border-line bg-transparent px-2 text-[16px] hover:border-line focus:border-accent md:order-none md:h-8 md:basis-0 md:border-transparent md:text-sm"
      />
      {group.kind === 'existing_label' && <span className="order-3 text-2xs text-faint md:order-none">Gmail label</span>}
      <span className="order-3 min-w-0 flex-1 text-right text-2xs tabular-nums text-faint md:order-none md:w-20 md:flex-none">{group.inboxCount} in inbox</span>
      <GroupBell group={group} onToggle={() => onPatch({ notify: !group.notify })} className="order-3 md:order-none" />
      {group.kind !== 'builtin' &&
        (confirming ? (
          <span className="order-3 flex items-center gap-2 text-xs md:order-none">
            <button type="button" aria-label="Confirm delete" className={danger} disabled={busy} onClick={onDelete}>
              Delete
            </button>
            <button type="button" className={button} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className={`${button} order-3 md:order-none`} onClick={() => setConfirming(true)}>
            Delete
          </button>
        ))}
    </li>
  );
}

function GroupsSection() {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: qk.groups(), queryFn: () => api.groups() });
  const labels = useQuery({ queryKey: qk.labels(), queryFn: api.labels });
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(NEW_GROUP_COLOR);
  const [label, setLabel] = useState('');

  const sorted = [...(groups.data ?? [])].sort((a, b) => a.position - b.position);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['groups'] });
  const patch = useGroupPatch();

  const reorder = useMutation({
    mutationFn: async ({ a, b }: { a: GroupDTO; b: GroupDTO }) =>
      Promise.all([api.patchGroup(a.id, { position: b.position }), api.patchGroup(b.id, { position: a.position })]),
    onMutate: ({ a, b }) => {
      const prev = qc.getQueryData<GroupDTO[]>(qk.groups());
      qc.setQueryData<GroupDTO[]>(qk.groups(), (old) =>
        old?.map((x) => (x.id === a.id ? { ...x, position: b.position } : x.id === b.id ? { ...x, position: a.position } : x)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(qk.groups(), ctx.prev),
    onSettled: refresh,
  });

  const create = useMutation({
    mutationFn: (r: CreateGroupRequest) => api.createGroup(r),
    onSuccess: () => {
      setNewName('');
      setNewColor(NEW_GROUP_COLOR);
      setLabel('');
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGroup(id),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['threads'] }); // its threads fall back to Unsorted
    },
  });

  const move = (i: number, dir: -1 | 1) => {
    const a = sorted[i];
    const b = sorted[i + dir];
    if (a && b) reorder.mutate({ a, b });
  };

  const used = new Set(sorted.filter((g) => g.kind === 'existing_label').map((g) => g.name));
  const freeLabels = (labels.data ?? []).filter((l) => !used.has(l.name));
  const error = patch.error ?? reorder.error ?? create.error ?? remove.error;

  return (
    <Section id="settings-groups" title="Groups">
      {groups.isPending ? (
        <Loading what="your groups" query={groups} />
      ) : groups.isError ? (
        <LoadError what="your groups" query={groups} />
      ) : (
        <ul>
          {sorted.map((g, i) => (
            <GroupRow
              key={g.id}
              group={g}
              first={i === 0}
              last={i === sorted.length - 1}
              busy={reorder.isPending || (remove.isPending && remove.variables === g.id)}
              onPatch={(p) => patch.mutate({ id: g.id, p })}
              onMove={(dir) => move(i, dir)}
              onDelete={() => remove.mutate(g.id)}
            />
          ))}
        </ul>
      )}

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (name) create.mutate({ name, color: newColor });
        }}
      >
        <span className="hidden w-12 shrink-0 md:block" aria-hidden />
        <input type="color" aria-label="New group color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className={colorInput} />
        <input
          type="text"
          aria-label="New group name"
          placeholder="New group"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded border border-line bg-transparent px-2 text-[16px] placeholder:text-faint focus:border-accent md:h-8 md:text-sm"
        />
        <button type="submit" className={button} disabled={!newName.trim() || create.isPending}>
          Add group
        </button>
      </form>

      <form
        className="mt-2 flex flex-wrap items-center gap-2 md:flex-nowrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (label) create.mutate({ name: label, existingLabelName: label });
        }}
      >
        <span className="w-full shrink-0 text-xs text-muted md:w-auto">Use a Gmail label as a group</span>
        <select
          aria-label="Gmail label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={labels.isPending || freeLabels.length === 0}
          className="h-11 min-w-0 flex-1 cursor-pointer rounded border border-line bg-bg px-2 text-[16px] md:h-8 md:text-xs"
        >
          <option value="">{labels.isPending ? 'Loading labels…' : freeLabels.length === 0 ? 'No unused labels' : 'Pick a label…'}</option>
          {freeLabels.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
        <button type="submit" className={button} disabled={!label || create.isPending}>
          Use as group
        </button>
      </form>
      <p className="mt-2 text-2xs text-faint">The label is used in place and never renamed. The bell turns new-mail notifications on or off for a group.</p>
      <LoadError what="your Gmail labels" query={labels} />
      <ErrorLine error={error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

const FILTER_ABOVE = 10;
const TAUGHT_ON = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The teaching as a sentence subject: `the list x`, `alibaba.com` in a rule, `*@alibaba.com` in a mark. */
function subject(t: TeachingDTO): string {
  if (t.matchType === 'list') return `the list ${t.matchValue}`;
  return t.kind === 'mark' && t.matchType === 'domain' ? `*@${t.matchValue}` : t.matchValue;
}

function capitalized(s: string): string {
  return s.startsWith('the ') ? `T${s.slice(1)}` : s;
}

const markName = (t: TeachingDTO) => (t.mark === 'important' ? 'Important' : 'Not important');

/** The row as one plain sentence: what the delete button says and what the filter searches. */
function teachingText(t: TeachingDTO): string {
  return t.kind === 'rule' ? `Always group ${subject(t)} to ${t.groupName}` : `${capitalized(subject(t))} is ${markName(t)}`;
}

function TeachingRow({ teaching: t, onRemove, removing }: { teaching: TeachingDTO; onRemove: () => void; removing: boolean }) {
  const text = teachingText(t);
  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-line py-1 last:border-b-0">
      {/* On a phone the sentence wraps above its details: clipped, it would not say what was taught. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-3">
        <span className="min-w-0 break-words md:flex-1 md:truncate" title={text}>
          {t.kind === 'rule' ? (
            <>
              Always group {subject(t)} <ArrowRight size={14} strokeWidth={1.75} aria-hidden className="inline-block align-[-2px] text-muted" />
              <span className="sr-only">to</span> {t.groupName}
            </>
          ) : (
            text
          )}
        </span>
        <span className="flex shrink-0 gap-3 text-2xs tabular-nums text-faint">
          <span>{TAUGHT_ON.format(t.createdAt)}</span>
          <span className="md:w-24 md:text-right">
            {t.threadCount} {t.threadCount === 1 ? 'email' : 'emails'} in inbox
          </span>
        </span>
      </div>
      <button type="button" aria-label={`Remove: ${text}`} title="Remove" disabled={removing} onClick={onRemove} className={iconButton}>
        <Trash2 size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

function RulesSection() {
  const qc = useQueryClient();
  // Teaching happens in the inbox, which does not touch this cache, so every visit asks again.
  const teaching = useQuery({ queryKey: qk.teaching(), queryFn: api.teaching, refetchOnMount: 'always' });
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState<{ key: number; message: string } | null>(null);
  const phone = useIsPhone();

  const remove = useMutation({
    mutationFn: (t: TeachingDTO) => api.deleteTeaching(t.kind, t.id),
    onSuccess: (_r, t) => {
      qc.setQueryData<TeachingDTO[]>(qk.teaching(), (old) => old?.filter((x) => x.id !== t.id));
      setToast({ key: Date.now(), message: t.threadCount > 0 ? 'Removed. Emails moved back.' : 'Removed.' });
    },
    onSettled: () => {
      for (const key of [qk.teaching(), ['groups'], ['threads']]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  const rows = teaching.data ?? [];
  // Above the limit only: below it the box is gone, and a leftover filter would hide rows with no way to clear it.
  const filterable = rows.length > FILTER_ABOVE;
  const term = filterable ? filter.trim().toLowerCase() : '';
  const shown = term ? rows.filter((t) => teachingText(t).toLowerCase().includes(term)) : rows;

  return (
    <Section
      id="settings-rules"
      title="What you've taught SuperMail"
      actions={
        filterable && (
          <input
            type="text"
            aria-label="Filter rules"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation(); // the first Escape clears the box; the next one leaves Settings
                setFilter('');
              }
            }}
            className="h-11 w-full min-w-0 rounded border border-line bg-transparent px-2 text-[16px] placeholder:text-faint focus:border-accent md:h-8 md:w-48 md:text-xs"
          />
        )
      }
    >
      {teaching.isPending ? (
        <Loading what="what you've taught SuperMail" query={teaching} />
      ) : teaching.isError ? (
        <LoadError what="what you've taught SuperMail" query={teaching} />
      ) : rows.length === 0 ? (
        phone ? (
          <p className="text-xs leading-6 text-muted">Use More on an email to teach SuperMail that its sender is important, not important, or always goes in one group.</p>
        ) : (
          <p className="text-xs leading-6 text-muted">
            Press <Kbd k="+" />, <Kbd k="-" /> or <Kbd k="l" /> on an email to teach SuperMail that its sender is important, not important, or always goes in one group.
          </p>
        )
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted">No rules match "{filter.trim()}".</p>
      ) : (
        <ul>
          {shown.map((t) => (
            <TeachingRow key={`${t.kind}:${t.id}`} teaching={t} removing={remove.isPending && remove.variables?.id === t.id} onRemove={() => remove.mutate(t)} />
          ))}
        </ul>
      )}
      <ErrorLine error={remove.error} />
      {toast && <UndoToast key={toast.key} message={toast.message} onClose={() => setToast((cur) => (cur?.key === toast.key ? null : cur))} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function mb(n: number): string {
  return `${n < 100 && !Number.isInteger(n) ? n.toFixed(1) : Math.round(n)} MB`;
}

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="tabular-nums text-muted">
          {mb(used)} / {mb(limit)}
        </span>
      </div>
      <div className="mt-1 h-1 rounded bg-hover">
        <div className={`h-1 rounded ${pct >= 90 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

function StorageSection() {
  const storage = useQuery({ queryKey: qk.storage(), queryFn: api.storage });
  const s: StorageUsageDTO | undefined = storage.data;
  return (
    <Section id="settings-storage" title="Storage">
      {storage.isPending ? (
        <Loading what="storage usage" query={storage} />
      ) : storage.isError || !s ? (
        <LoadError what="storage usage" query={storage} />
      ) : (
        <>
          {s.degraded && (
            <div role="alert" className="mb-3 rounded border border-line bg-warn-bg px-3 py-2 text-xs text-fg">
              A storage limit was reached, so caching and history indexing are paused. Reading, sending and sorting mail keep working.
            </div>
          )}
          <ul className="max-w-md text-xs">
            <UsageRow label="Body cache" used={s.bodyCacheMB} limit={s.limits.bodyCacheMB} />
            <UsageRow label="Mail index" used={s.indexMB} limit={s.limits.indexMB} />
            <UsageRow label="Logs" used={s.logsMB} limit={s.limits.logsMB} />
            <UsageRow label="Everything in /data" used={s.totalMB} limit={s.limits.totalMB} />
            <li className="flex items-center justify-between gap-3 py-2">
              <span>Disk</span>
              <span className={`tabular-nums ${s.diskFreeGB < s.limits.minFreeDiskGB ? 'font-semibold text-danger' : 'text-muted'}`}>
                {Math.round(s.diskFreeGB)} GB free (keeps at least {s.limits.minFreeDiskGB} GB)
              </span>
            </li>
          </ul>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function Settings() {
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => location.assign('/login'),
  });
  return (
    <Layout context="settings">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h1 className="text-base font-semibold">Settings</h1>
        <button type="button" className={button} disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </button>
      </div>
      <div className="flex max-w-3xl flex-col gap-3 p-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:block md:p-0">
        <NotificationsSection />
        <AccountsSection />
        <GroupsSection />
        <RulesSection />
        <StorageSection />
      </div>
      <CommandPalette context="settings" />
    </Layout>
  );
}
