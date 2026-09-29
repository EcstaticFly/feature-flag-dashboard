'use client';

import { ChevronRight, Target } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { toggleFlagAction } from '@/app/actions/flags';
import { RelativeTime } from '@/components/relative-time';
import { Switch } from '@/components/ui/switch';
import { Badge, Card } from '@/components/ui/misc';
import type { Flag } from '@/lib/flags';

/**
 * The flag list.
 *
 * One layout, two presentations: a table on wide screens, stacked cards on
 * narrow ones. The enabled switch is the kill switch — it writes immediately
 * rather than waiting for a save.
 */
export function FlagRows({ flags }: { flags: Flag[] }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="divide-y divide-border-subtle overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,2fr)_7rem_6rem_minmax(0,1fr)_2rem] gap-4 bg-canvas/60 px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-muted sm:grid">
          <span>Flag</span>
          <span>Status</span>
          <span>Rollout</span>
          <span>Last updated</span>
          <span className="sr-only">Open</span>
        </div>

        {flags.map((flag) => (
          <FlagRow key={flag.id} flag={flag} onError={setError} />
        ))}
      </Card>
    </div>
  );
}

function FlagRow({ flag, onError }: { flag: Flag; onError: (message: string | null) => void }) {
  const [pending, startTransition] = useTransition();
  // Mirrors the server value so the switch responds instantly; revalidatePath
  // brings the authoritative value back.
  const [enabled, setEnabled] = useState(flag.enabled);
  // Re-seed when the server record changes — otherwise a change made elsewhere
  // (the detail page, another tab, the integration endpoint) would leave this
  // row showing a stale position after revalidation.
  useEffect(() => setEnabled(flag.enabled), [flag.enabled, flag.updatedAt]);
  const rules = flag.targetingRules?.length ?? 0;

  function onToggle(next: boolean) {
    setEnabled(next);
    onError(null);
    startTransition(async () => {
      const result = await toggleFlagAction(flag.key, next);
      if (!result.ok) {
        setEnabled(!next); // put the switch back where it was
        onError(result.error ?? 'Could not update the flag.');
      }
    });
  }

  return (
    <div className="grid grid-cols-1 gap-3 px-5 py-4 transition-colors hover:bg-canvas/40 sm:grid-cols-[minmax(0,2fr)_7rem_6rem_minmax(0,1fr)_2rem] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <Link
          href={`/flags/${flag.key}`}
          className="block truncate font-medium text-ink hover:text-brand"
          title={flag.name}
        >
          {flag.name}
        </Link>
        <div className="mt-0.5 flex items-center gap-2">
          <code className="truncate text-xs text-ink-muted" title={flag.key}>
            {flag.key}
          </code>
          {rules > 0 && (
            <Badge tone="brand" title={`${rules} targeting rule${rules === 1 ? '' : 's'}`}>
              <Target className="h-3 w-3" />
              {rules}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={pending}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${flag.key}`}
        />
        <span className="text-sm text-ink-muted sm:hidden">{enabled ? 'On' : 'Off'}</span>
      </div>

      <div className="text-sm">
        {enabled ? (
          <span className="font-medium tabular-nums">{flag.rolloutPercentage}%</span>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </div>

      <div className="min-w-0 text-sm text-ink-muted">
        {flag.lastUpdatedAt ? (
          <>
            <span className="block truncate" title={flag.lastUpdatedBy ?? undefined}>
              {flag.lastUpdatedBy}
            </span>
            <RelativeTime iso={flag.lastUpdatedAt} className="text-xs" />
          </>
        ) : (
          <span className="text-xs">never changed</span>
        )}
      </div>

      <Link
        href={`/flags/${flag.key}`}
        className="hidden justify-self-end text-ink-muted hover:text-ink sm:block"
        aria-label={`Open ${flag.key}`}
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
