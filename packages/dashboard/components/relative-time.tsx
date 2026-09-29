'use client';

import { useEffect, useState } from 'react';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

function relative(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (elapsed < 60_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) return formatter.format(-Math.round(elapsed / ms), unit);
  }
  return 'just now';
}

/**
 * Shows "2 minutes ago", with the exact timestamp on hover.
 *
 * The server renders the absolute time and only the browser rewrites it to a
 * relative one. Formatting "ago" on the server would compute against the
 * server's clock at render time and hydrate to a different string — the classic
 * Next.js hydration mismatch.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  // A single piece of state so the server render and the first client render
  // are byte-identical. `toLocaleString()` must not run during render either:
  // the server's locale and the browser's disagree ("29/9/2026" vs "9/29/2026")
  // and React would report a hydration mismatch on the title attribute.
  const [local, setLocal] = useState<{ label: string; title: string } | null>(null);

  useEffect(() => {
    const format = () => setLocal({ label: relative(iso), title: new Date(iso).toLocaleString() });
    format();
    // Keep it honest while the page stays open.
    const timer = setInterval(format, 30_000);
    return () => clearInterval(timer);
  }, [iso]);

  const fallback = iso.replace('T', ' ').slice(0, 16);

  return (
    <time dateTime={iso} title={local?.title ?? fallback} className={className}>
      {local?.label ?? fallback}
    </time>
  );
}
