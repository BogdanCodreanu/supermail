import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd, keyCaps } from '../src/components/Kbd';

describe('Kbd', () => {
  it('draws one cap per key', () => {
    expect(keyCaps('Ctrl+Enter')).toEqual(['Ctrl', '↵']);
    expect(keyCaps('Shift+j')).toEqual(['Shift', 'J']);
    const { container } = render(<Kbd k="Ctrl+k" />);
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'K']);
  });

  it('uses the type scale and the 4px grid, no arbitrary pixel sizes', () => {
    const { container } = render(<Kbd k="e" />);
    const cap = container.querySelector('kbd')!;
    expect(cap).toHaveClass('text-2xs');
    expect(cap.className).not.toMatch(/\[[\d.]+px\]/);
  });
});
