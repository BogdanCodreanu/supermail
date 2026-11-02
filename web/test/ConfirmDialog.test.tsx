import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/ConfirmDialog';

function Host({ onConfirm, onCancel }: { onConfirm(): void; onCancel(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <ConfirmDialog
          title="Discard draft?"
          message="It will be deleted."
          confirmLabel="Discard"
          tone="danger"
          onConfirm={() => {
            setOpen(false);
            onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            onCancel();
          }}
        />
      )}
    </>
  );
}

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<Host onConfirm={onConfirm} onCancel={onCancel} />);
  const opener = screen.getByRole('button', { name: 'open' });
  opener.focus();
  fireEvent.click(opener);
  return { onConfirm, onCancel, opener, dialog: screen.getByRole('dialog', { name: 'Discard draft?' }) };
}

describe('ConfirmDialog', () => {
  it('is a labelled modal dialog with focus on the confirm button', () => {
    const { dialog } = setup();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('It will be deleted.');
    expect(screen.getByRole('button', { name: /Discard/ })).toHaveFocus();
  });

  it('Enter confirms and focus returns to where it was', () => {
    const { dialog, onConfirm, opener } = setup();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Escape cancels, without reaching window shortcut handlers', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    onTestFinished(() => window.removeEventListener('keydown', onWindowKey));
    const { dialog, onCancel, onConfirm } = setup();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog', () => {
    const { dialog } = setup();
    const cancel = screen.getByRole('button', { name: /Cancel/ });
    const confirm = screen.getByRole('button', { name: /Discard/ });
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('Enter on the focused Cancel button cancels instead of confirming', () => {
    const { onConfirm } = setup();
    const cancel = screen.getByRole('button', { name: /Cancel/ });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
