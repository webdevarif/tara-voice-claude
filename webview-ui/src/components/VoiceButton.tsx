import React, { useRef } from 'react';

interface VoiceButtonProps {
  isListening: boolean;
  onStart: () => void;
  onEnd: () => void;
}

export function VoiceButton({ isListening, onStart, onEnd }: VoiceButtonProps) {
  const holdRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    if (holdRef.current) return;
    holdRef.current = true;
    onStart();
  }

  function handlePointerUp() {
    if (!holdRef.current) return;
    holdRef.current = false;
    onEnd();
  }

  return (
    <button
      id="tara-voice-btn"
      className={`tara-voice-btn ${isListening ? 'listening' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
      title={isListening ? 'Release to send' : 'Hold to speak (Ctrl+Shift+Space)'}
      aria-label={isListening ? 'Recording — release to send' : 'Hold to speak'}
      aria-pressed={isListening}
    >
      {/* Ripple rings */}
      {isListening && (
        <>
          <span className="tara-voice-ring ring-1" />
          <span className="tara-voice-ring ring-2" />
          <span className="tara-voice-ring ring-3" />
        </>
      )}

      {/* Mic icon */}
      <svg
        className="tara-voice-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="21" />
        <line x1="9" y1="21" x2="15" y2="21" />
      </svg>
    </button>
  );
}
