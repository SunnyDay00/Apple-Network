import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function Toast({ id, message, onDismiss }: { id: number; message: string; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    // A replacement notice gets its own lifetime; old timers cannot clear it.
    const leaveTimer = window.setTimeout(() => setLeaving(true), 3000);
    const dismissTimer = window.setTimeout(() => onDismiss(id), 3220);
    return () => { window.clearTimeout(leaveTimer); window.clearTimeout(dismissTimer); };
  }, [id, onDismiss]);

  return createPortal(
    <div className="toast-layer">
      <div className={`notification-toast ${leaving ? 'is-leaving' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="toast-indicator" aria-hidden="true" /><span className="toast-message">{message}</span>
      </div>
    </div>, document.body,
  );
}
