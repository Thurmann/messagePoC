import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HandleDialog } from './HandleDialog';
import { renderWithState } from './testUtils';

const openDialog = (seq = 1) => (s: Parameters<Parameters<typeof renderWithState>[1] & object>[0]) => ({
  ...s,
  dialog: { ...s.dialog, open: true, openSeq: seq },
});

describe('HandleDialog', () => {
  it('is closed initially with the form contract', () => {
    renderWithState(<HandleDialog />);
    const dlg = document.getElementById('handle-dialog') as HTMLDialogElement;
    expect(dlg.open).toBe(false);
    expect(document.getElementById('handle-form')).toHaveAttribute('method', 'dialog');
    const input = document.getElementById('handle-input');
    expect(input).toHaveAttribute('maxlength', '20');
    expect(input).toBeRequired();
    expect(document.getElementById('handle-error')).not.toBeVisible();
  });

  it('opens modally and focuses the input, refocusing on every open request', () => {
    const { store } = renderWithState(<HandleDialog />);
    act(() => store.set((s) => openDialog(1)(s)));
    const dlg = document.getElementById('handle-dialog') as HTMLDialogElement;
    const input = document.getElementById('handle-input') as HTMLInputElement;
    expect(dlg.open).toBe(true);
    expect(input).toHaveFocus();
    input.blur();
    act(() => store.set((s) => openDialog(2)(s)));
    expect(input).toHaveFocus();
  });

  it('closes natively when the store closes it, and reports a native close', () => {
    const { store, actions } = renderWithState(<HandleDialog />, openDialog());
    const dlg = document.getElementById('handle-dialog') as HTMLDialogElement;
    expect(dlg.open).toBe(true);
    act(() => store.set((s) => ({ ...s, dialog: { ...s.dialog, open: false } })));
    expect(dlg.open).toBe(false);
    expect(actions.closeHandleDialog).toHaveBeenCalled();
  });

  it('cancel calls closeHandleDialog', () => {
    const { actions } = renderWithState(<HandleDialog />, openDialog());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.closeHandleDialog).toHaveBeenCalled();
  });

  it('submits the typed value without clearing it', () => {
    const { actions } = renderWithState(<HandleDialog />, openDialog());
    const input = document.getElementById('handle-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  alice ' } });
    fireEvent.submit(document.getElementById('handle-form') as HTMLElement);
    expect(actions.saveHandle).toHaveBeenCalledWith('  alice ');
    expect(input.value).toBe('  alice ');
  });

  it('shows the error and disables Save while saving', () => {
    renderWithState(<HandleDialog />, (s) => ({ ...s, dialog: { ...s.dialog, error: 'Nope', saving: true } }));
    expect(document.getElementById('handle-error')).toHaveTextContent('Nope');
    expect(document.getElementById('handle-error')).toHaveAttribute('role', 'alert');
    expect(document.getElementById('handle-save')).toBeDisabled();
  });
});
