import { useEffect, useRef, type FormEvent } from 'react';
import { useActions, useAppState } from './AppContext';

export function HandleDialog() {
  const actions = useActions();
  const { open, openSeq, error, saving } = useAppState((s) => s.dialog);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open) {
      if (!dlg.open) {
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      }
      inputRef.current?.focus();
    } else if (dlg.open) {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }
  }, [open, openSeq]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    actions.saveHandle(inputRef.current?.value ?? '');
  }

  return (
    <dialog id="handle-dialog" className="dialog" ref={dialogRef} onClose={(e) => {
        // a stale queued close event after a quick reopen must not close the dialog again
        if (!e.currentTarget.open) actions.closeHandleDialog();
      }}>
      <form id="handle-form" method="dialog" autoComplete="off" onSubmit={onSubmit}>
        <h2>Choose your handle</h2>
        <p className="hint">3-20 characters: letters, digits or underscore. It cannot be changed later.</p>
        <input type="text" id="handle-input" maxLength={20} aria-label="Handle" required ref={inputRef} />
        <div className="error" id="handle-error" role="alert" hidden={!error}>
          {error}
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" id="handle-cancel" onClick={() => actions.closeHandleDialog()}>
            Cancel
          </button>
          <button type="submit" className="btn primary" id="handle-save" disabled={saving}>
            Save handle
          </button>
        </div>
      </form>
    </dialog>
  );
}
