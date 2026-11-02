import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, GroupDTO, ThreadSummaryDTO } from '@supermail/shared';
import { endScreens, pressBack, stubPhone } from './phoneEnv';

vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return { ...real, api: { groups: vi.fn(), teachPreview: vi.fn(), createGroup: vi.fn() } };
});

const { api } = await import('../src/api/client');
const { AccountSwitcher } = await import('../src/components/AccountSwitcher');
const { CommandPalette } = await import('../src/components/CommandPalette');
const { ConfirmDialog } = await import('../src/components/ConfirmDialog');
const { ContextMenu } = await import('../src/components/ContextMenu');
const { GroupPicker } = await import('../src/components/GroupPicker');
const { ScopePrompt } = await import('../src/components/ScopePrompt');
const { SnoozePicker } = await import('../src/components/SnoozePicker');

const thread = {
  id: 'a:t1',
  accountId: 'a',
  subject: 'Lunch on Friday',
  fromName: 'Ana',
  fromEmail: 'irina@example.com',
} as ThreadSummaryDTO;

const groups = [
  { id: 'dev', name: 'Dev', color: '#111111', position: 1 },
  { id: 'news', name: 'Newsletters', color: '#222222', position: 2 },
] as GroupDTO[];

const accounts: AccountDTO[] = [
  { id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' },
  { id: 'b', email: 'ops@example.com', color: '#16a34a', status: 'ok' },
];

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const noKeyHints = () => expect(document.querySelector('kbd')).toBeNull();

beforeEach(() => {
  stubPhone();
  vi.clearAllMocks();
  vi.mocked(api.groups).mockResolvedValue([]);
  vi.mocked(api.teachPreview).mockResolvedValue({ sender: { value: 'irina@example.com', count: 3 } } as never);
});

afterEach(endScreens);

describe('SnoozePicker', () => {
  it('is a sheet of full-width 48px rows, without key hints or the keyboard', () => {
    const onPick = vi.fn();
    wrap(<SnoozePicker open onPick={onPick} onClose={vi.fn()} />);
    const sheet = screen.getByRole('dialog', { name: 'Snooze until…' });
    expect(sheet.parentElement!.parentElement).toBe(document.body);
    noKeyHints();
    const row = within(sheet).getAllByRole('button').find((b) => b.classList.contains('h-12'))!;
    expect(row).toHaveClass('w-full', 'md:h-8');
    expect(screen.getByLabelText('Snooze until')).not.toHaveFocus();
    expect(screen.getByLabelText('Snooze until')).toHaveClass('text-[16px]');
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('offers a typed time as a row to tap, since there may be no Enter to press', () => {
    const onPick = vi.fn();
    wrap(<SnoozePicker open onPick={onPick} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Snooze until'), { target: { value: 'tomorrow 9am' } });
    expect(screen.queryByText(/press Enter/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Snooze until / }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('closes on the back gesture', async () => {
    const onClose = vi.fn();
    wrap(<SnoozePicker open onPick={vi.fn()} onClose={onClose} />);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GroupPicker', () => {
  it('is a sheet of 48px rows, with 44px scope chips and no key hints or keyboard', async () => {
    const onPick = vi.fn();
    wrap(<GroupPicker open thread={thread} groups={groups} onPick={onPick} onClose={vi.fn()} />);
    const sheet = await screen.findByRole('dialog', { name: 'Move to group' });
    noKeyHints();
    expect(screen.getByLabelText('Filter groups')).not.toHaveFocus();
    expect(within(sheet).getByRole('radio', { name: 'Only this email' })).toHaveClass('h-11', 'md:h-6');
    const dev = within(sheet).getByRole('button', { name: 'Dev' });
    expect(dev).toHaveClass('h-12', 'w-full');
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Only this email' }));
    expect(screen.getByLabelText('Filter groups')).not.toHaveFocus();
    fireEvent.click(dev);
    expect(onPick).toHaveBeenCalledWith({ id: 'dev', name: 'Dev' }, 'thread');
  });
});

describe('ScopePrompt', () => {
  it('applies an option on tap, from 48px rows with no key hints', async () => {
    const onConfirm = vi.fn();
    wrap(<ScopePrompt open title="Mark as important" thread={thread} confirmKeys={['+']} onConfirm={onConfirm} onClose={vi.fn()} />);
    const sheet = await screen.findByRole('dialog', { name: 'Mark as important' });
    noKeyHints();
    const only = within(sheet).getByRole('radio', { name: 'Only this email' });
    expect(only).toHaveClass('min-h-12', 'w-full');
    fireEvent.click(only);
    expect(onConfirm).toHaveBeenCalledWith('thread');
  });
});

describe('ConfirmDialog', () => {
  it('is a sheet with two full-width buttons and no key hints', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Discard draft?" message="It will be deleted." confirmLabel="Discard" tone="danger" onConfirm={onConfirm} onCancel={onCancel} />);
    const sheet = screen.getByRole('dialog', { name: 'Discard draft?' });
    expect(within(sheet).getByText('It will be deleted.')).toBeInTheDocument();
    noKeyHints();
    const confirm = within(sheet).getByRole('button', { name: 'Discard' });
    expect(confirm).toHaveClass('h-12', 'w-full', 'bg-danger');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('AccountSwitcher', () => {
  function Switcher({ onChange }: { onChange(id: string | null): void }) {
    const [value, setValue] = useState<string | null>(null);
    return (
      <AccountSwitcher
        accounts={accounts}
        value={value}
        onChange={(id) => {
          setValue(id);
          onChange(id);
        }}
      />
    );
  }

  it('is a sheet listing the accounts, and choosing one closes it', async () => {
    const onChange = vi.fn();
    wrap(<Switcher onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: All accounts' }));
    const sheet = await screen.findByRole('dialog', { name: 'Accounts' });
    const rows = within(sheet).getAllByRole('menuitemradio');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveClass('min-h-12', 'w-full');
    fireEvent.click(rows[1]!);
    expect(onChange).toHaveBeenCalledWith('a');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Manage accounts goes to Settings, and survives the sheet leaving history', async () => {
    wrap(<Switcher onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: All accounts' }));
    const sheet = await screen.findByRole('dialog', { name: 'Accounts' });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    fireEvent.click(within(sheet).getByRole('menuitem', { name: 'Manage accounts…' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/settings'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('what the phone does not show', () => {
  it('ContextMenu shows nothing, and tells its opener it closed', () => {
    const onClose = vi.fn();
    render(<ContextMenu label="Email actions" x={10} y={10} items={[{ id: 'a', label: 'Open', onSelect: vi.fn() }]} onClose={onClose} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('CommandPalette does not open, even from a hardware keyboard', () => {
    wrap(<CommandPalette context="list" />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });
});
