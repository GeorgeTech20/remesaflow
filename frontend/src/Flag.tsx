// Inline SVG flags, circular (Wise-style). Unicode flag emoji render as plain
// two-letter codes on Chrome/Windows (Chrome deliberately doesn't use Windows'
// emoji font for flags) — SVG guarantees identical rendering everywhere.
import type { JSX } from 'react';

const FLAGS: Record<string, JSX.Element> = {
  KES: (
    <>
      <rect width="30" height="10" y="0" fill="#000" />
      <rect width="30" height="10" y="10" fill="#BB0000" />
      <rect width="30" height="10" y="20" fill="#006600" />
      <rect width="30" height="2" y="9" fill="#fff" />
      <rect width="30" height="2" y="19" fill="#fff" />
      <g transform="translate(15,15)">
        <polygon points="-5,-7 5,-7 3,3 -3,3" fill="#BB0000" stroke="#000" strokeWidth="0.6" />
        <line x1="-6" y1="-9" x2="-2" y2="6" stroke="#fff" strokeWidth="1" />
        <line x1="6" y1="-9" x2="2" y2="6" stroke="#fff" strokeWidth="1" />
      </g>
    </>
  ),
  PHP: (
    <>
      <rect width="30" height="15" y="0" fill="#0038A8" />
      <rect width="30" height="15" y="15" fill="#CE1126" />
      <polygon points="0,0 14,15 0,30" fill="#fff" />
      <circle cx="4.5" cy="15" r="3" fill="#FCD116" />
      <circle cx="1.5" cy="6" r="1.1" fill="#FCD116" />
      <circle cx="1.5" cy="24" r="1.1" fill="#FCD116" />
      <circle cx="9" cy="15" r="1.1" fill="#FCD116" />
    </>
  ),
  BRL: (
    <>
      <rect width="30" height="30" fill="#009739" />
      <polygon points="15,4 28,15 15,26 2,15" fill="#FEDD00" />
      <circle cx="15" cy="15" r="6.2" fill="#012169" />
    </>
  ),
  COP: (
    <>
      <rect width="30" height="15" y="0" fill="#FCD116" />
      <rect width="30" height="7.5" y="15" fill="#003893" />
      <rect width="30" height="7.5" y="22.5" fill="#CE1126" />
    </>
  ),
  NGN: (
    <>
      <rect width="10" height="30" x="0" fill="#008751" />
      <rect width="10" height="30" x="10" fill="#fff" />
      <rect width="10" height="30" x="20" fill="#008751" />
    </>
  ),
};

export function Flag({ code, size = 20 }: { code: string; size?: number }) {
  const inner = FLAGS[code];
  if (!inner) return null;
  const clipId = `flag-clip-${code}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 30 30"
      className="inline-block shrink-0 align-middle"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="15" cy="15" r="15" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>{inner}</g>
    </svg>
  );
}
