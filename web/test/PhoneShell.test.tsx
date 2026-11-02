import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useEffect, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupDTO } from '@supermail/shared';
import { GroupTabs } from '../src/components/GroupTabs';
import { Layout } from '../src/components/Layout';
import { whenBackSettled } from '../src/components/phone/backStack';
import { stubPhone } from './phone';

const settled = () => new Promise<void>((r) => whenBackSettled(r));

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function shell(path: string, props: Partial<Parameters<typeof Layout>[0]> = {}) {
  render(
    <MemoryRouter initialEntries={['/elsewhere', path]} initialIndex={1}>
      <Layout context={path === '/' ? 'list' : 'skipped'} {...props}>
        <p>content</p>
      </Layout>
      <Where />
    </MemoryRouter>,
  );
}
const appBar = () => screen.getByRole('banner');

describe('the phone app bar', () => {
  beforeEach(async () => {
    stubPhone();
    await settled();
  });

  it('is 56px, with the account control, then Search, then More', () => {
    shell('/', { top: <button type="button">Account</button> });
    expect(appBar().querySelector('[data-testid="app-bar-row"]')!.className).toContain('h-14');
    const names = [...appBar().querySelectorAll('a, button')].map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(names).toEqual(['Account', 'Search', 'More']);
  });

  it('keeps the computer header out of the way', () => {
    shell('/');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Compose/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('respects the status bar', () => {
    shell('/');
    expect(appBar().className).toContain('pt-[env(safe-area-inset-top)]');
  });

  it('gives its controls 44px targets with press feedback', () => {
    shell('/skipped');
    for (const name of ['Back', 'Search', 'More']) {
      const el = within(appBar()).getByRole(name === 'Search' ? 'link' : 'button', { name });
      expect(el.className).toContain('h-11');
      expect(el.className).toContain('w-11');
      expect(el.className).toContain('active:bg-hover');
      expect(el.className).toContain('touch-manipulation');
    }
  });

  it('shows Back and the screen title off the inbox', () => {
    shell('/skipped');
    expect(within(appBar()).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(appBar()).getByText('Skipped')).toBeInTheDocument();
  });

  it('shows no Back on the inbox', () => {
    shell('/');
    expect(within(appBar()).queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('takes the whole bar for a screen with its own, keeping Back', () => {
    shell('/search', { phoneBar: <input aria-label="Search mail" /> });
    expect(within(appBar()).getByRole('textbox', { name: 'Search mail' })).toBeInTheDocument();
    expect(within(appBar()).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(appBar()).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(within(appBar()).queryByRole('link', { name: 'Search' })).not.toBeInTheDocument();
  });
});

describe('the More sheet', () => {
  beforeEach(async () => {
    stubPhone();
    await settled();
  });
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More' }));

  it('offers Skipped, Spam, Show done and Settings on the inbox', () => {
    shell('/');
    openMore();
    const sheet = screen.getByRole('dialog', { name: 'More' });
    expect([...sheet.querySelectorAll('a, [role="switch"]')].map((el) => el.textContent)).toEqual(['Skipped', 'Spam', 'Show done', 'Settings']);
  });

  it('has no Show done off the inbox, where it does nothing', () => {
    shell('/skipped');
    openMore();
    expect(within(screen.getByRole('dialog', { name: 'More' })).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('toggles Show done and stays open', () => {
    shell('/');
    openMore();
    const toggle = screen.getByRole('switch', { name: 'Show done' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('switch', { name: 'Show done' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Show done' }));
  });

  it('goes to the screen only after the sheet has left history', async () => {
    shell('/');
    openMore();
    await settled();
    fireEvent.click(screen.getByRole('link', { name: 'Spam' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/spam'));
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
  });

  it('closes on the Android back gesture, not the screen', async () => {
    shell('/skipped');
    openMore();
    await settled();
    act(() => void window.dispatchEvent(new PopStateEvent('popstate', { state: null })));
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/skipped');
  });
});

describe('the group slider', () => {
  const group = (id: string, name: string, inboxCount: number): GroupDTO => ({ id, name, position: 0, color: '#64748b', notify: false, kind: 'builtin', inboxCount, unreadCount: 0 });
  const GROUPS = [group('important', 'Important', 7), group('dev', 'Dev', 8), group('low', 'Low priority', 9)];
  const PILL = 100;
  const VIEW = 360;

  function Slider({ onCreate, initial = null }: { onCreate?(name: string): Promise<void>; initial?: string | null }) {
    const [selected, setSelected] = useState<string | null>(initial);
    return (
      <>
        <GroupTabs groups={GROUPS} selected={selected} onSelect={setSelected} onCreate={onCreate} />
        <output data-testid="selected">{String(selected)}</output>
      </>
    );
  }

  /** jsdom has no layout: pills sit side by side, each 100 wide, and the first is centred at scrollLeft 0. */
  function layOut() {
    const track = screen.getByTestId('group-slider');
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: VIEW });
    screen.getAllByRole('tab').forEach((tab, i) => {
      Object.defineProperty(tab, 'offsetLeft', { configurable: true, value: 130 + i * (PILL + 8) });
      Object.defineProperty(tab, 'offsetWidth', { configurable: true, value: PILL });
    });
    return track;
  }
  const slideTo = (track: HTMLElement, pill: number) => {
    track.scrollLeft = pill * (PILL + 8);
    fireEvent.scroll(track);
  };
  const selected = () => screen.getByTestId('selected').textContent;

  beforeEach(async () => {
    stubPhone();
    vi.stubGlobal('onscrollend', undefined); // an older browser, unless a test says otherwise
    await settled();
  });
  afterEach(() => vi.useRealTimers());

  it('gives the row 48px of its own, above its border', () => {
    render(
      <MemoryRouter>
        <Layout context="list" sub={<span>slider</span>}>
          <p>content</p>
        </Layout>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('subheader').className).toContain('h-[49px]');
  });

  it('is one 48px scroll-snap slider of tabs with counts, All first', () => {
    render(<Slider />);
    const track = screen.getByTestId('group-slider');
    expect(track.className).toContain('overflow-x-auto');
    expect(track.className).toContain('snap-x');
    expect(track.className).toContain('snap-mandatory');
    expect(track.className).toContain('overscroll-x-none');
    expect(within(screen.getByRole('tablist', { name: 'Groups' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All24', 'Important7', 'Dev8', 'Low priority9']);
  });

  it('snaps each group to the centre, with a 48px target', () => {
    render(<Slider />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('snap-center');
      expect(tab.className).toContain('h-12');
      expect(tab.className).toContain('touch-manipulation');
    }
  });

  it('has no More menu for groups', () => {
    render(<Slider />);
    expect(screen.queryByRole('button', { name: /More groups/ })).not.toBeInTheDocument();
  });

  it('makes the centred group active once the slider settles', () => {
    vi.useFakeTimers();
    render(<Slider />);
    const track = layOut();
    slideTo(track, 2);
    expect(selected()).toBe('null');
    act(() => void vi.advanceTimersByTime(120));
    expect(selected()).toBe('dev');
  });

  it('settles at once on scrollend', () => {
    render(<Slider />);
    const track = layOut();
    slideTo(track, 1);
    act(() => void track.dispatchEvent(new Event('scrollend')));
    expect(selected()).toBe('important');
  });

  it('can land several groups along on a fast flick, and only changes group once', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={spy} />);
    const track = layOut();
    slideTo(track, 1);
    slideTo(track, 2);
    slideTo(track, 3);
    act(() => void vi.advanceTimersByTime(120));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('low');
  });

  it('waits while the finger is still down', () => {
    vi.useFakeTimers();
    render(<Slider />);
    const track = layOut();
    track.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientX: 100, clientY: 20 }] }));
    slideTo(track, 2);
    act(() => void vi.advanceTimersByTime(500));
    expect(selected()).toBe('null');
    track.dispatchEvent(new Event('touchend', { bubbles: true }));
    act(() => void vi.advanceTimersByTime(120));
    expect(selected()).toBe('dev');
  });

  it('does not change group when it settles where it was', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<GroupTabs groups={GROUPS} selected="dev" onSelect={spy} />);
    const track = layOut();
    slideTo(track, 2);
    act(() => void vi.advanceTimersByTime(120));
    expect(spy).not.toHaveBeenCalled();
  });

  it('goes back to All, the first stop', () => {
    vi.useFakeTimers();
    render(<Slider initial="dev" />);
    const track = layOut();
    slideTo(track, 0);
    act(() => void vi.advanceTimersByTime(120));
    expect(selected()).toBe('null');
  });

  it('moves to a group on tap too, centring it', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<Slider />);
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: /Low priority/ }));
    expect(screen.getByRole('tab', { name: /Low priority/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: 'center' })));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByRole('tab', { name: /Low priority/ }));
  });

  it('reaches a tapped group even when the scroll stalls on the way, as rendering its list can make it', () => {
    vi.useFakeTimers();
    render(<Slider />);
    const track = layOut();
    fireEvent.click(screen.getByRole('tab', { name: /Low priority/ }));
    slideTo(track, 1);
    act(() => void vi.advanceTimersByTime(500));
    expect(selected()).toBe('low');
    slideTo(track, 3);
    act(() => void track.dispatchEvent(new Event('scrollend')));
    expect(selected()).toBe('low');
  });

  it('lets a swipe take over from a tap still on its way', () => {
    vi.useFakeTimers();
    render(<Slider />);
    const track = layOut();
    fireEvent.click(screen.getByRole('tab', { name: /Low priority/ }));
    slideTo(track, 1);
    track.dispatchEvent(new Event('touchstart', { bubbles: true }));
    slideTo(track, 2);
    track.dispatchEvent(new Event('touchend', { bubbles: true }));
    act(() => void vi.advanceTimersByTime(120));
    expect(selected()).toBe('dev');
  });

  describe('where the browser has scrollend', () => {
    beforeEach(() => vi.stubGlobal('onscrollend', null));

    it('does not guess from a pause in the scroll', () => {
      vi.useFakeTimers();
      render(<Slider />);
      const track = layOut();
      slideTo(track, 2);
      act(() => void vi.advanceTimersByTime(200));
      expect(selected()).toBe('null');
      act(() => void track.dispatchEvent(new Event('scrollend')));
      expect(selected()).toBe('dev');
    });

    it('still settles if scrollend never comes', () => {
      vi.useFakeTimers();
      render(<Slider />);
      const track = layOut();
      slideTo(track, 2);
      act(() => void vi.advanceTimersByTime(1_000));
      expect(selected()).toBe('dev');
    });
  });

  it('tracks the centred group with the underline during the swipe, by transform', () => {
    render(<Slider />);
    const track = layOut();
    const line = screen.getByTestId('slider-underline');
    expect(line.className).toContain('bg-accent');
    slideTo(track, 1);
    expect(line.style.transform).toContain('scaleX');
    const before = line.style.transform;
    Object.defineProperty(screen.getAllByRole('tab')[2]!, 'offsetWidth', { configurable: true, value: 200 });
    track.scrollLeft = (PILL + 8) * 1.5;
    fireEvent.scroll(track);
    expect(line.style.transform).not.toBe(before);
  });

  it('fades the neighbours and keeps the centred pill solid', () => {
    render(<Slider />);
    const track = layOut();
    slideTo(track, 1);
    const [all, important] = screen.getAllByRole('tab');
    expect(Number(important!.style.opacity)).toBeCloseTo(1, 1);
    expect(Number(all!.style.opacity)).toBeLessThan(1);
    expect(Number(all!.style.opacity)).toBeGreaterThan(0);
  });

  it('keeps New group as the last stop by tap only: it never becomes active on a swipe', () => {
    vi.useFakeTimers();
    render(<Slider onCreate={vi.fn(async () => {})} />);
    const plus = screen.getByRole('button', { name: 'New group' });
    expect(plus.className).not.toContain('snap-');
    expect(plus.className).toContain('h-11');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    const track = layOut();
    slideTo(track, 9);
    act(() => void vi.advanceTimersByTime(120));
    expect(selected()).toBe('low');
  });

  it('sits the plus after the last group, inside the slider', () => {
    render(<Slider onCreate={vi.fn(async () => {})} />);
    const track = screen.getByTestId('group-slider');
    const plus = screen.getByRole('button', { name: 'New group' });
    expect(track.contains(plus)).toBe(true);
    expect(screen.getByRole('tablist').contains(plus)).toBe(false);
  });

  describe('the ends of the slider', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(VIEW);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(PILL);
    });

    it('sit a whole screen beyond the first and last pill, so one drag can never reach the browser\'s back gesture', () => {
      render(<Slider />);
      const row = screen.getByTestId('slider-row');
      const centring = (VIEW - PILL) / 2;
      expect(parseFloat(row.style.paddingLeft)).toBe(VIEW + centring);
      expect(parseFloat(row.style.paddingRight)).toBe(VIEW + centring);
    });

    it('put that room on a row inside the scroller: on the scroller itself it would widen it, and feed itself', () => {
      render(<Slider />);
      const track = screen.getByTestId('group-slider');
      expect(track.style.paddingLeft).toBe('');
      expect(track.style.paddingRight).toBe('');
      expect(track.contains(screen.getByTestId('slider-row'))).toBe(true);
      expect(screen.getByTestId('slider-row').className).toContain('w-max');
    });

    it('keep that room when the plus takes part of the last stretch', () => {
      render(<Slider onCreate={vi.fn(async () => {})} />);
      const centring = (VIEW - PILL) / 2;
      expect(parseFloat(screen.getByTestId('slider-row').style.paddingRight)).toBe(VIEW + centring - PILL);
    });

    it('place the active pill before the first paint, so the empty room never shows', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      let calledBeforeEffects = false;
      function Probe() {
        useEffect(() => {
          calledBeforeEffects = scrollIntoView.mock.calls.length > 0;
        }, []);
        return null;
      }
      render(
        <>
          <Slider initial="dev" />
          <Probe />
        </>,
      );
      expect(calledBeforeEffects).toBe(true);
      expect(scrollIntoView.mock.calls[0]![0]).toMatchObject({ inline: 'center', behavior: 'auto' });
    });

    it('never stop a touch, so nothing fights the scroll', () => {
      render(<Slider />);
      const track = screen.getByTestId('group-slider');
      const at = (type: string, x: number) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'touches', { value: [{ identifier: 1, clientX: x, clientY: 80 }] });
        track.dispatchEvent(e);
        return e;
      };
      at('touchstart', 100);
      expect(at('touchmove', 300).defaultPrevented).toBe(false);
    });
  });

  it('creates a group from a sheet with a 16px field, so Android does not zoom', async () => {
    const onCreate = vi.fn(async () => {});
    render(<Slider onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const field = within(screen.getByRole('dialog', { name: 'New group' })).getByRole('textbox', { name: 'Group name' });
    expect(field.className).toContain('text-[16px]');
    fireEvent.change(field, { target: { value: 'Clients' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Clients'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New group' })).not.toBeInTheDocument());
  });

  it('shows why a group could not be created, and keeps the sheet', async () => {
    render(<Slider onCreate={async () => { throw new Error('Name taken'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name taken');
    expect(screen.getByRole('dialog', { name: 'New group' })).toBeInTheDocument();
  });
});

describe('sideways overscroll', () => {
  it('stays on the page on a phone, and leaves the computer alone', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/phone/phone.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*html,\s*body \{\s*overscroll-behavior-x: none;/);
  });
});
