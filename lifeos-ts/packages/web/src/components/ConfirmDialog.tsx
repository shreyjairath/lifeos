'use client';

import type { ConfirmRequest } from '@/lib/types';

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export default function ConfirmDialog({ request, onApprove, onDeny }: ConfirmDialogProps) {
  return (
    <div className="overlay-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onDeny(); }}>
      <div className="confirm-dialog">
        <h3>Tool Permission Request</h3>
        <div className="confirm-dialog-tool">{request.name}</div>
        <div
          style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}
        >
          Allow this tool call?
        </div>
        <div className="confirm-dialog-input">
          {JSON.stringify(request.input, null, 2)}
        </div>
        <div className="confirm-dialog-actions">
          <button className="btn btn-secondary" onClick={onDeny}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={onApprove}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
