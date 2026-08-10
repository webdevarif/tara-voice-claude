import { useEffect, useRef, useState } from 'react';

/**
 * Four states, not two, because "the microphone is on" and "you are being heard"
 * are different facts, and conflating them is what makes hands-free listening
 * feel broken — you cannot tell whether it is your turn.
 */
export type MicState = 'off' | 'listening' | 'hearing' | 'asleep';

interface VoiceOrbProps {
  micState: MicState;
  /** A click switches listening on or off. There is no hold. */
  onToggle: () => void;
}

const NUM_BARS = 32;
const ORB_RADIUS = 48;   // px — distance from center to bar base
const BAR_MIN = 4;
const BAR_MAX = 22;
const CENTER = 80;        // SVG viewBox center

const LABEL: Record<MicState, string> = {
  off: 'Click to talk',
  listening: 'Listening',
  hearing: 'Hearing you…',
  asleep: 'Asleep — say "wake up"',
};

const TITLE: Record<MicState, string> = {
  off: 'Start listening',
  listening: 'Listening — click to stop',
  hearing: 'Picking up your voice',
  asleep: 'Sleeping after 15s of silence — say "wake up", or click to stop',
};

export function VoiceOrb({ micState, onToggle }: VoiceOrbProps) {
  const [bars, setBars] = useState<number[]>(Array(NUM_BARS).fill(BAR_MIN));
  const animFrameRef = useRef<number>(0);
  const live = micState === 'hearing';
  const on = micState !== 'off';

  // ── Bar animation ─────────────────────────────────────────────────────────
  // There is no AnalyserNode to drive this: the samples never enter this
  // document, they go from the recorder straight to the Gemini socket in the
  // extension host. So the bars are synthetic, and only their tempo carries
  // meaning — lively while speech is being heard, slow while merely listening,
  // barely moving while asleep or off.
  useEffect(() => {
    const speed = live ? 0.08 : micState === 'listening' ? 0.05 : 0.03;
    const depth = live ? 1 : micState === 'listening' ? 0.3 : 0;
    let t = 0;
    const tick = () => {
      t += speed;
      setBars(
        Array.from({ length: NUM_BARS }, (_, i) => {
          const angle = (i / NUM_BARS) * Math.PI * 2;
          if (depth === 0) {
            const wave = Math.sin(t + angle) * 0.5 + 0.5;
            return BAR_MIN + wave * 3; // very subtle idle pulse
          }
          const v =
            Math.abs(Math.sin(t * 1.3 + angle)) * 0.6 +
            Math.abs(Math.sin(t * 2.1 + angle * 1.7)) * 0.4;
          return BAR_MIN + v * depth * (BAR_MAX - BAR_MIN);
        })
      );
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current!);
  }, [live, micState]);

  // Asleep is "on but not paying attention", so it reads as active-but-dimmed
  // rather than off, which would suggest a click is needed to resume.
  const accent = live
    ? '#5b5fc7'
    : micState === 'listening'
      ? '#4a4ea8'
      : on
        ? '#33365e'
        : '#2e3045';
  const coreFill = live ? '#5b5fc7' : on ? '#1b1d2c' : '#111318';
  const strokeCol = live ? '#7b7fd4' : on ? '#3a3d7a' : '#252730';
  const iconCol = live ? '#fff' : on ? '#b9bce0' : '#6b6e8a';

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
        fill={accent}
        opacity={on ? 0.9 : 0.5}
        style={{ transition: 'fill 0.4s ease, opacity 0.4s ease' }}
      />
    );
  });

  return (
    <div className="voice-orb-wrapper">
      <button
        id="tara-voice-btn"
        className={`voice-orb-btn ${live ? 'listening' : ''} ${on ? 'mic-on' : ''}`}
        onClick={onToggle}
        onContextMenu={(e) => e.preventDefault()}
        title={TITLE[micState]}
        aria-label={TITLE[micState]}
        aria-pressed={on}
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
            stroke={on ? accent : '#22242e'}
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
            stroke={on ? '#3a3d7a' : '#1a1c26'}
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
            fill={coreFill}
            stroke={strokeCol}
            strokeWidth="1"
            className={live ? 'orb-core-pulse' : ''}
            style={{ transition: 'fill 0.3s ease, stroke 0.3s ease' }}
          />

          {/* Mic icon in center */}
          <g transform={`translate(${CENTER - 8}, ${CENTER - 11})`}>
            <rect x="5" y="0" width="6" height="10" rx="3"
              fill="none" stroke={iconCol}
              strokeWidth="1.5"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <path d="M2 7a6 6 0 0 0 12 0"
              fill="none" stroke={iconCol}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <line x1="8" y1="13" x2="8" y2="16"
              stroke={iconCol}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            <line x1="5" y1="16" x2="11" y2="16"
              stroke={iconCol}
              strokeWidth="1.5" strokeLinecap="round"
              style={{ transition: 'stroke 0.3s ease' }}
            />
            {micState === 'asleep' && (
              // A slash across the mic: sleeping is not the same as off, but it
              // is also not listening for commands, and the label alone is easy
              // to miss.
              <line x1="1" y1="1" x2="15" y2="17"
                stroke={iconCol} strokeWidth="1.5" strokeLinecap="round" opacity="0.8"
              />
            )}
          </g>
        </svg>

        {/* Label */}
        <span className="voice-orb-label">{LABEL[micState]}</span>
      </button>
    </div>
  );
}
