import { Flag as FlagIcon, LogOut } from 'lucide-react';
import Link from 'next/link';
import { ApiUnreachableError } from '@/lib/api';
import { listFlags, type Flag } from '@/lib/flags';
import { CreateFlagDialog } from '@/components/create-flag-dialog';
import { FlagRows } from '@/components/flag-rows';
import { Button } from '@/components/ui/button';
import { Card, ErrorPanel } from '@/components/ui/misc';

/**
 * The flag list.
 *
 * A Server Component: it reads the session cookie and calls the Express API
 * server-to-server, so the JWT never reaches the browser and no CORS is
 * involved. `cache: 'no-store'` (in lib/api.ts) keeps it from ever showing an
 * admin stale flag state.
 */
export default async function FlagsPage() {
  let flags: Flag[] | null = null;
  let unreachable = false;

  try {
    flags = await listFlags();
  } catch (err) {
    // A dead API must degrade to an explanatory panel, never a blank screen.
    if (err instanceof ApiUnreachableError) unreachable = true;
    else throw err;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
              <FlagIcon className="h-4 w-4" />
            </span>
            Feature Flags
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {flags?.length
              ? `${flags.length} flag${flags.length === 1 ? '' : 's'} in this environment.`
              : 'Ship code dark, roll out gradually, roll back instantly.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <CreateFlagDialog />
          <Button asChild variant="ghost" size="icon" title="Sign out">
            <a href="/api/logout" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </header>

      {unreachable ? (
        <ErrorPanel
          title="The flag service is unreachable"
          message="The dashboard could not contact the API. Flags already delivered to your apps keep working — the SDK serves its last known values."
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/flags">Try again</Link>
            </Button>
          }
        />
      ) : flags && flags.length === 0 ? (
        <EmptyState />
      ) : (
        <FlagRows flags={flags ?? []} />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="px-6 py-14 text-center">
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <FlagIcon className="h-5 w-5" />
      </span>
      <h2 className="text-base font-semibold">No flags yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
        Create your first flag, then wrap the new code path in{' '}
        <code className="rounded bg-canvas px-1.5 py-0.5 text-xs">isEnabled()</code>. You can ship
        it turned off and roll it out when you are ready.
      </p>
      <div className="mt-6 flex justify-center">
        <CreateFlagDialog />
      </div>
    </Card>
  );
}
