import { render, screen } from '@testing-library/react';
import { Check } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { waitingForNetwork } from '../src/components/LoadFailure';
import { SelectionBar } from '../src/components/phone/SelectionBars';

describe('phone leftovers', () => {
  it('the selection bar lifts toasts above itself', () => {
    render(<SelectionBar actions={[{ label: 'Done', icon: Check, run: vi.fn() }] as never} />);
    expect(screen.getByTestId('selection-bar')).toHaveAttribute('data-bottom-bar');
  });

  it('a list with nothing cached counts as waiting for the network while its query is paused', () => {
    expect(waitingForNetwork({ isPending: true, fetchStatus: 'paused' })).toBe(true);
    expect(waitingForNetwork({ isPending: true, fetchStatus: 'fetching' })).toBe(false);
    expect(waitingForNetwork({ isPending: false, fetchStatus: 'paused' })).toBe(false);
  });
});
