import type React from "react";

const ICONS = {
  chat: (
    <>
      <path d="M4 5h16v11H10l-5 4v-4H4z" />
      <path d="M8 10v2M11 8.5v5M14 9.5v3M17 10.5v1" />
    </>
  ),
  agent: (
    <>
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.5V8" />
      <circle cx="12" cy="3.5" r="1.2" />
      <circle cx="9.3" cy="13.3" r="1.3" fill="currentColor" />
      <circle cx="14.7" cy="13.3" r="1.3" fill="currentColor" />
      <path d="M2.5 12.5v3M21.5 12.5v3" />
    </>
  ),
  skill: (
    <>
      <path d="M3 5h5.5A3.5 3.5 0 0 1 12 8.5V20a2.5 2.5 0 0 0-2.5-2.5H3z" />
      <path d="M21 5h-5.5A3.5 3.5 0 0 0 12 8.5V20a2.5 2.5 0 0 1 2.5-2.5H21z" />
    </>
  ),
  memory: (
    <>
      <path d="M12 5.5A3 3 0 0 0 6.5 4 3 3 0 0 0 4 8.5a3.2 3.2 0 0 0 0 5.5 3 3 0 0 0 3 4.5A3 3 0 0 0 12 19.5z" />
      <path d="M12 5.5A3 3 0 0 1 17.5 4 3 3 0 0 1 20 8.5a3.2 3.2 0 0 1 0 5.5 3 3 0 0 1-3 4.5 3 3 0 0 1-5 1z" />
      <path d="M12 5.5v14" />
    </>
  ),
  sessions: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  plan: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V2.8h6V4" />
      <path d="M8.5 10l1.5 1.5L12.5 9M8.5 16h7" />
    </>
  ),
  bolt: <path d="M13 2.5L4.5 14H11l-1 7.5L19.5 10H13z" />,
  wave: <path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5" />,
  knob: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12l4-4" />
    </>
  ),
  wiring: (
    <>
      <circle cx="5" cy="7" r="2.2" />
      <circle cx="5" cy="17" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
      <path d="M7.2 7c5 0 5 5 9.6 5M7.2 17c5 0 5-5 9.6-5" />
    </>
  ),
  track: (
    <>
      <path d="M6 3v18M12 3v18M18 3v18" />
      <rect x="4" y="13" width="4" height="3" fill="currentColor" />
      <rect x="10" y="6" width="4" height="3" fill="currentColor" />
      <rect x="16" y="10" width="4" height="3" fill="currentColor" />
    </>
  ),
  context: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  approval: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

/** Decorative line icon. Name the control it sits in, not the icon. */
export function Icon({
  name,
  className,
  style,
}: {
  name: IconName;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <svg
      className={`icon ${className ?? ""}`.trim()}
      style={style}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}
