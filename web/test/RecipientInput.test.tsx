import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadDetailDTO, ThreadPage } from '@supermail/shared';
import { formatAddress, isValidEmail, knownPeople, parseRecipients, RecipientInput } from '../src/components/RecipientInput';

function Harness({ initial = [], qc, onValues }: { initial?: string[]; qc: QueryClient; onValues?: (v: string[]) => void }) {
  const [values, setValues] = useState(initial);
  const [pending, setPending] = useState('');
  return (
    <QueryClientProvider client={qc}>
      <RecipientInput
        label="To"
        values={values}
        onChange={(v) => {
          setValues(v);
          onValues?.(v);
        }}
        pending={pending}
        onPending={setPending}
        exclude={new Set(['me@gmail.com'])}
      />
      <button type="button">elsewhere</button>
    </QueryClientProvider>
  );
}

function setup(initial: string[] = [], qc = new QueryClient()) {
  const onValues = vi.fn();
  render(<Harness initial={initial} qc={qc} onValues={onValues} />);
  const input = screen.getByRole('combobox', { name: 'To recipients' });
  const chips = () => screen.queryAllByTestId('recipient-chip');
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  return { input, chips, type, onValues };
}

function seededCache(): QueryClient {
  const qc = new QueryClient();
  const page: ThreadPage = {
    nextCursor: null,
    threads: [
      { id: 'a:1', accountId: 'a', subject: 's', snippet: '', fromName: 'Ana Pop', fromEmail: 'ana@example.com', lastMessageAt: 3, unread: false, inInbox: true, groupId: 'g', groupName: 'G', reason: { source: 'default', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false },
      { id: 'a:2', accountId: 'a', subject: 's', snippet: '', fromName: 'Ana Pop', fromEmail: 'ana@example.com', lastMessageAt: 2, unread: false, inInbox: true, groupId: 'g', groupName: 'G', reason: { source: 'default', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false },
    ],
  };
  qc.setQueryData(['threads', { accountId: null, groupId: null }], { pages: [page], pageParams: [null] });
  const detail: ThreadDetailDTO = {
    thread: page.threads[0]!,
    messages: [
      {
        id: 'a:m1', gmailMessageId: 'm1', from: { name: 'Andrei', email: 'andrei@work.ro' }, to: [{ name: null, email: 'me@gmail.com' }, { name: 'Anca', email: 'anca@work.ro' }],
        cc: [{ name: null, email: 'bob@example.com' }], date: 1, subject: 's', html: null, text: null, attachments: [],
      },
    ],
  };
  qc.setQueryData(['thread', 'a:1'], detail);
  for (let i = 0; i < 8; i++) qc.setQueryData(['search', `q${i}`], { nextCursor: null, threads: [{ ...page.threads[0]!, fromName: null, fromEmail: `al${i}@lots.com` }] });
  return qc;
}

describe('parsing', () => {
  it('splits pasted lists outside quotes and angle brackets', () => {
    expect(parseRecipients('Name <a@b.co>, c@d.co')).toEqual(['Name <a@b.co>', 'c@d.co']);
    expect(parseRecipients('"Doe, Jane" <j@d.co>; x@y.co\nz@w.co')).toEqual(['"Doe, Jane" <j@d.co>', 'x@y.co', 'z@w.co']);
    expect(parseRecipients('a@b.co c@d.co')).toEqual(['a@b.co', 'c@d.co']);
    expect(parseRecipients('<a@b.co>')).toEqual(['a@b.co']);
  });

  it('validates emails', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('not an email')).toBe(false);
    expect(formatAddress({ name: 'Doe, Jane', email: 'j@d.co' })).toBe('"Doe, Jane" <j@d.co>');
  });
});

describe('RecipientInput', () => {
  it.each([
    ['Enter', { key: 'Enter' }],
    ['comma', { key: ',' }],
    ['Tab', { key: 'Tab' }],
  ])('commits typed text on %s', (_, ev) => {
    const { input, chips, type } = setup();
    type('dan@example.com');
    fireEvent.keyDown(input, ev);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toHaveTextContent('dan@example.com');
    expect(input).toHaveValue('');
  });

  it('commits on blur, and Tab followed by blur adds the address once', () => {
    const { input, chips, type } = setup();
    type('dan@example.com');
    fireEvent.blur(input);
    expect(chips()).toHaveLength(1);
    type('eve@example.com');
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.blur(input);
    expect(chips()).toHaveLength(2);
  });

  it('marks an invalid address in danger styling with a tooltip', () => {
    const { input, chips, type } = setup();
    type('not-an-email');
    fireEvent.keyDown(input, { key: 'Enter' });
    const chip = chips()[0]!;
    expect(chip).toHaveAttribute('data-invalid', 'true');
    expect(chip.className).toMatch(/bg-danger-bg/);
    expect(within(chip).getByRole('button', { name: /not a valid email address/i })).toHaveAttribute('title', 'Not a valid email address: not-an-email');
  });

  it('splits a pasted "Name <a@b>, c@d" into chips', () => {
    const { input, chips } = setup();
    fireEvent.paste(input, { clipboardData: { getData: () => 'Ana Pop <ana@example.com>, cy@example.com' } });
    expect(chips().map((c) => c.textContent)).toEqual(['Ana Pop', 'cy@example.com']);
    expect(screen.getByRole('button', { name: 'Edit Ana Pop <ana@example.com>' })).toHaveAttribute('title', 'Ana Pop <ana@example.com>');
  });

  it('Backspace in an empty field selects the last chip first, then removes it', () => {
    const { input, chips } = setup(['a@example.com', 'b@example.com']);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(chips()).toHaveLength(2);
    expect(chips()[1]).toHaveAttribute('data-selected', 'true');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(chips().map((c) => c.textContent)).toEqual(['a@example.com']);
  });

  it('typing after selecting a chip clears the selection instead of deleting', () => {
    const { input, chips, type } = setup(['a@example.com']);
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyDown(input, { key: 'x' });
    type('x');
    expect(chips()[0]).not.toHaveAttribute('data-selected');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(chips()).toHaveLength(1);
  });

  it('clicking a chip puts it back into the field for editing', () => {
    const { input, chips } = setup(['a@example.con', 'b@example.com']);
    fireEvent.click(screen.getByRole('button', { name: 'Edit a@example.con' }));
    expect(chips().map((c) => c.textContent)).toEqual(['b@example.com']);
    expect(input).toHaveValue('a@example.con');
    expect(input).toHaveFocus();
  });

  it('the remove button removes a chip', () => {
    const { chips } = setup(['a@example.com', 'b@example.com']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
    expect(chips().map((c) => c.textContent)).toEqual(['b@example.com']);
  });

  it('suggests people from the query cache; arrows and Enter pick one', () => {
    const { input, chips, type } = setup([], seededCache());
    type('an');
    const list = screen.getByRole('listbox', { name: 'To suggestions' });
    // Most frequent first; the owner's own address never shows.
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Ana Popana@example.com', 'Andreiandrei@work.ro', 'Ancaanca@work.ro']);
    expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[1]!.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(chips().map((c) => c.textContent)).toEqual(['Andrei']);
    expect(screen.getByRole('button', { name: 'Edit Andrei <andrei@work.ro>' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows at most 6 suggestions, skips people already added, and picks by click', () => {
    const { chips, type } = setup(['al0@lots.com'], seededCache());
    type('al');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(6);
    expect(options.map((o) => o.textContent)).not.toContain('al0@lots.com');
    fireEvent.click(options[2]!);
    expect(chips()).toHaveLength(2);
  });

  it('a fully typed address wins over suggestions on Enter; Escape closes the list', () => {
    const { input, chips, type } = setup([], seededCache());
    type('ana@example.co');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true); // the composer must not close as well
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(chips().map((c) => c.textContent)).toEqual(['ana@example.co']);
  });

  it('knownPeople ranks by frequency and drops excluded and invalid addresses', () => {
    const people = knownPeople(seededCache(), new Set(['bob@example.com']));
    expect(people[0]).toEqual({ name: 'Ana Pop', email: 'ana@example.com' });
    expect(people.map((p) => p.email)).not.toContain('bob@example.com');
  });
});
