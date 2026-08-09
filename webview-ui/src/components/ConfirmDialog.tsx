interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Confirm risky command">
      <div className="confirm-dialog">
        <div className="confirm-icon">⚠️</div>
        <pre className="confirm-message">{message}</pre>
        <div className="confirm-actions">
          <button
            id="tara-confirm-cancel-btn"
            className="confirm-btn confirm-btn-cancel"
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
          <button
            id="tara-confirm-proceed-btn"
            className="confirm-btn confirm-btn-proceed"
            onClick={onConfirm}
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
