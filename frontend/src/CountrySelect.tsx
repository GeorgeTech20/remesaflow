// Native <select>/<option> cannot render SVG or images inside options — hard
// browser limitation, not a React one. Wise-style flag dropdowns require a
// hand-built listbox instead of a native select.
import { useEffect, useRef, useState } from 'react';
import type { Currency } from './api';
import { Flag } from './Flag';

export function CountrySelect({
  currencies,
  value,
  onChange,
  label,
}: {
  currencies: Currency[];
  value: string;
  onChange: (code: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = currencies.find((c) => c.code === value) ?? currencies[0];

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <span className="mb-1.5 block text-sm font-semibold text-neutral-400">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl border border-neutral-700 bg-ink px-4 py-3 text-lg font-bold text-white outline-none transition focus:border-celo"
      >
        {selected && <Flag code={selected.code} size={22} />}
        <span className="flex-1 text-left">
          {selected ? `${selected.country} — ${selected.code}` : '—'}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          className={`shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            d="M5 7l5 5 5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-neutral-700 bg-ink shadow-xl shadow-black/40"
        >
          {currencies.map((c) => (
            <li key={c.code}>
              <button
                type="button"
                role="option"
                aria-selected={c.code === value}
                onClick={() => {
                  onChange(c.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 px-4 py-3 text-left text-base font-semibold transition hover:bg-celo/10 ${
                  c.code === value ? 'bg-celo/10 text-celo' : 'text-white'
                }`}
              >
                <Flag code={c.code} size={20} />
                <span>
                  {c.country} — {c.code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
