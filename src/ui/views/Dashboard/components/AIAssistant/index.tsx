import React, { useState } from 'react';
import { AISheet } from './AISheet';
import './style.less';

/**
 * AIAssistant — floating action button + bottom sheet.
 *
 * Mount once inside Dashboard so it sits on top of the whole popup UI.
 * The ✦ button is fixed at bottom-right; clicking it opens the Drawer sheet.
 */
export function AIAssistant() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="ai-fab"
        onClick={() => setOpen(true)}
        title="AI Assistant"
        aria-label="Open AI Assistant"
      >
        <span className="ai-fab__spark">✦</span>
        AI
      </button>

      <AISheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
