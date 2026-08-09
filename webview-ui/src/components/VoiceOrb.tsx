import { useEffect, useRef, useState } from 'react';

interface VoiceOrbProps {
  isListening: boolean;
  onStart: () => void;
  onEnd: () => void;
  analyserNode?: AnalyserNode | null;
}

const NUM_BARS = 32;
const ORB_RADIUS = 48;   // px — distance from center to bar base
const BAR_MIN = 4;
const BAR_MAX = 22;
const CENTER = 80;        // SVG viewBox center

export function VoiceOrb({ isListening, onStart, onEnd, analyserNode }: VoiceOrbProps) {
  const [bars, setBars] = useState<number[]>(Array(NUM_BARS).fill(BAR_MIN));
  const animFrameRef = useRef<number>(0);
  const holdRef = useRef(false);

  // ── Audio-reactive bar animation ─────────────────────────────────────────
  useEffect(() => {
    if (!isListening) {
      // Idle breathing — subtle low-amplitude wave
      let t = 0;
      const idle = () => {
        t += 0.04;
        setBars(
          Array.from({ length: NUM_BARS }, (_, i) => {
            const wave = Math.sin(t + (i / NUM_BARS) * Math.PI * 2) * 0.5 + 0.5;
            return BAR_MIN + wave * 3; // very subtle idle pulse
          })
        );
        animFrameRef.current = requestAnimationFrame(idle);
      };
      animFrameRef.current = requestAnimationFrame(idle);
      return () => cancelAnimationFrame(animFrameRef.current!);
    }

    if (analyserNode) {
      // Real frequency data from mic
      const data = new Uint8Array(analyserNode.frequencyBinCount);
      const draw = () => {
        analyserNode.getByteFrequencyData(data);
        const step = Math.floor(data.length / NUM_BARS);
        setBars(
          Array.from({ length: NUM_BARS }, (_, i) => {
            const value = data[i * step] / 255;
            return BAR_MIN + value * (BAR_MAX - BAR_MIN);
          })
        );
        animFrameRef.current = requestAnimationFrame(draw);
      };
      animFrameRef.current = requestAnimationFrame(draw);
    } else {
      // CSS fallback — fake energetic animation
      let t = 0;
      const fake = () => {
        t += 0.08;
        setBars(
          Array.from({ length: NUM_BARS }, (_, i) => {
            const angle = (i / NUM_BARS) * Math.PI * 2;
            const v =
              Math.abs(Math.sin(t * 1.3 + angle)) * 0.6 +
              Math.abs(Math.sin(t * 2.1 + angle * 1.7)) * 0.4;
            return BAR_MIN + v * (BAR_MAX - BAR_MIN);
          })
        );
        animFrameRef.current = requestAnimationFrame(fake);
      };
      animFrameRef.current = requestAnimationFrame(fake);
    }

    return () => cancelAnimationFrame(animFrameRef.current!);
  }, [isListening, analyserNode]);

  // ── Pointer handlers ──────────────────────────────────────────────────────
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

  // ── Build SVG bars arranged in a circle ───────────────────────────────────
  const barEls = bars.map((h, i) => {
    const angle = (i / NUM_BARS) * 360 - 90; // start from top
    const rad = (angle * Math.PI) / 180;
    // bar base sits at ORB_RADIUS from center, extends outward
    const x = CENTER + ORB_RADIUS * Math.cos(rad);
    const y = CENTER + ORB_RADIUS * Math.sin(rad);

    return (
      <rect
        key={i}
        x={x - 1.5}
        y={y - h}
        width={3}
        height={h}
        rx={1.5}
        transform={`rotate(${angle + 90}, ${x}, ${y})`}
        fill={isListening ? '#5b5fc7' : '#2e3045'}
        opacity={isListening ? 0.9 : 0.5}
        style={{ transition: 'fill 0.4s ease, opacity 0.4s ease' }}
      />
    );
  });

  return (
    <div className="voice-orb-wrapper">
      <button
        id="tara-voice-btn"
        className={`voice-orb-btn ${isListening ? 'listening' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
        title={isListening ? 'Release to send' : 'Hold to speak'}
        aria-label={isListening ? 'Recording — release to send' : 'Hold to speak'}
        aria-pressed={isListening}
      >
        {/* Circular EQ bars */}
        <svg
          className="voice-orb-svg"
          viewBox="0 0 160 160"
          aria-hidden="true"
        >
          {/* Rotating orbital rings */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={ORB_RADIUS - 2}
            fill="none"
            stroke={isListening ? '#5b5fc7' : '#22242e'}
            strokeWidth="1"
            strokeDasharray="4 6"
            className="orb-ring-1"
            style={{ transition: 'stroke 0.4s ease' }}
          />
          <circle
            cx={CENTER}
            cy={CENTER}
            r={ORB_RADIUS + 12}
            fill="none"
            stroke={isListening ? '#3a3d7a' : '#1a1c26'}
            strokeWidth="1"
            strokeDasharray="2 8"
            className="orb-ring-2"
            style={{ transition: 'stroke 0.4s ease' }}
          />

          {/* Frequency bars */}
          {barEls}

          {/* Center orb circle */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={28}
            fill={isListening ? '#5b5fc7' : '#111318'}
            stroke={isListening ? '#7b7fd4' : '#252730'}
            strokeWidth="1"
            className={isListening ? 'orb-core-pulse' : ''}
            style={{ transition: 'fill 0.3s ease, stroke 0.3s ease' }}
          />

          {/* Mic icon in center */}
          <g transform={`translate(${CENTER - 8}, ${CENTER - 11})`}>
            <rect x="5" y="0" width="6" height="10" rx="3"
              fill="none" stroke={isListening ? '#fff' : '#6b6e8a'}
              strokeWidth="1.5"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <path d="M2 7a6 6 0 0 0 12 0"
              fill="none" stroke={isListening ? '#fff' : '#6b6e8a'}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <line x1="8" y1="13" x2="8" y2="16"
              stroke={isListening ? '#fff' : '#6b6e8a'}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <line x1="5" y1="16" x2="11" y2="16"
              stroke={isListening ? '#fff' : '#6b6e8a'}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
          </g>
        </svg>

        {/* Label */}
        <span className="voice-orb-label">
          {isListening ? 'Listening…' : 'Hold to speak'}
        </span>
      </button>
    </div>
  );
}
