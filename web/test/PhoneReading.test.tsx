import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSrcdoc, MessageBody } from '../src/components/MessageBody';
import { RecipientInput } from '../src/components/RecipientInput';
import { Login } from '../src/views/Login';
import { endScreens, stubKeyboard, stubPhone } from './phoneEnv';

const plain = (over = {}) => ({ html: null, text: 'Hello there', subject: 'Hi', ...over });
const designed = { html: '<table width="700" bgcolor="#ffffff"><tr><td>News</td></tr></table>', text: null, subject: 'News' };
const unstyled = { html: '<p>Just a note</p>', text: null, subject: 'Note' };

beforeEach(stubPhone);
afterEach(endScreens);

describe('reading on the phone', () => {
  it('sets text-only mail at 15px with 1.6 line height, and 13px from md up', () => {
    render(<MessageBody message={plain()} />);
    expect(screen.getByText('Hello there')).toHaveClass('text-base', 'leading-[1.6]', 'md:text-sm', 'md:leading-relaxed');
  });

  it('sets HTML mail at 15px inside the frame, but only when asked: a wide frame would never match a media query', () => {
    expect(buildSrcdoc('<p>x</p>', null, false, true)).toContain('body{font-size:15px}');
    expect(buildSrcdoc('<p>x</p>')).not.toContain('font-size:15px');
    render(<MessageBody message={unstyled} />);
    expect(screen.getByTitle('Note').getAttribute('srcdoc')).toContain('body{font-size:15px}');
  });

  it('runs the white canvas of designed mail to the screen edges, with no rounded card', () => {
    render(<MessageBody message={designed} />);
    const canvas = document.querySelector('[data-canvas="white"]')!;
    expect(canvas).toHaveClass('-mx-4', 'md:mx-0', 'md:rounded');
    expect(canvas).not.toHaveClass('rounded');
  });

  it('keeps mail in the app theme inside the gutters', () => {
    render(<MessageBody message={unstyled} />);
    expect(document.querySelector('[data-canvas="theme"]')).not.toHaveClass('-mx-4');
  });

  it('leaves the browser pinch zoom alone: nothing around the frame takes the gesture', () => {
    render(<MessageBody message={designed} />);
    for (let el: HTMLElement | null = screen.getByTitle('News'); el; el = el.parentElement) expect(el.style.touchAction).toBe('');
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '').not.toMatch(/user-scalable=no|maximum-scale/);
  });

  it('keeps the quoted text toggle, with a 44px target', () => {
    render(<MessageBody message={plain({ text: 'Mine\n\nOn Mon, Ana wrote:\n> theirs' })} />);
    const toggle = screen.getByRole('button', { name: 'Show quoted text' });
    expect(toggle).toHaveClass('h-11', 'w-11', 'md:h-6', 'md:w-8');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide quoted text' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('recipients on the phone', () => {
  function people() {
    const qc = new QueryClient();
    qc.setQueryData(['search', 'x'], {
      threads: [
        { fromName: 'Irina Vasile', fromEmail: 'irina@example.com', lastMessageAt: 2 },
        { fromName: 'Andrei Pop', fromEmail: 'andrei@example.com', lastMessageAt: 1 },
      ],
    });
    return qc;
  }
  function Field({ qc }: { qc: QueryClient }) {
    const [values, setValues] = useState<string[]>([]);
    const [pending, setPending] = useState('');
    return (
      <QueryClientProvider client={qc}>
        <RecipientInput label="To" values={values} onChange={setValues} pending={pending} onPending={setPending} />
      </QueryClientProvider>
    );
  }
  const input = () => screen.getByRole('combobox', { name: 'To recipients' });

  it('types at 16px, so Android does not zoom in', () => {
    render(<Field qc={people()} />);
    expect(input()).toHaveClass('text-[16px]', 'h-11', 'md:text-sm');
  });

  it('shows suggestions in a strip right above the keyboard, with 44px rows that a tap picks', () => {
    const view = stubKeyboard(740);
    render(<Field qc={people()} />);
    fireEvent.change(input(), { target: { value: 'ir' } });
    const list = screen.getByRole('listbox', { name: 'To suggestions' });
    expect(list).toHaveClass('fixed', 'inset-x-0');
    expect(list.style.bottom).toBe('0px');
    act(() => {
      view.height = 440;
      view.dispatchEvent(new Event('resize'));
    });
    expect(list.style.bottom).toBe('300px');
    const row = within(list).getAllByRole('option')[0]!;
    expect(row).toHaveClass('min-h-11');
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    expect(screen.getByTestId('recipient-chip')).toHaveTextContent('Irina Vasile');
  });

  it('gives a chip 44px controls', () => {
    render(<Field qc={people()} />);
    fireEvent.change(input(), { target: { value: 'irina@example.com,' } });
    fireEvent.blur(input());
    expect(screen.getByRole('button', { name: 'Remove irina@example.com' })).toHaveClass('h-11', 'w-11', 'md:h-6');
    expect(screen.getByRole('button', { name: 'Edit irina@example.com' })).toHaveClass('h-11');
  });
});

describe('Login on the phone', () => {
  it('has a 48px sign-in button, centred, and a 44px privacy link', () => {
    render(<Login />);
    const signIn = screen.getByRole('link', { name: /sign in with google/i });
    expect(signIn).toHaveClass('h-12', 'justify-center', 'md:h-8');
    expect(signIn.parentElement).toHaveClass('items-center', 'justify-center', 'h-dvh');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveClass('h-11', 'md:h-6');
  });
});
