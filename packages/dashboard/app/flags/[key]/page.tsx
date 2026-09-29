import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, ApiUnreachableError } from '@/lib/api';
import { getFlag, getFlagAudit, type AuditEntry, type Flag } from '@/lib/flags';
import { AuditTimeline } from '@/components/audit-timeline';
import { FlagEditor } from '@/components/flag-editor';
import { Button } from '@/components/ui/button';
import { ErrorPanel } from '@/components/ui/misc';

/**
 * Flag detail: edit the rollout and targeting, and read who changed what.
 *
 * Same Server Component pattern as the list — the cookie is read here, the API
 * is called server-side, nothing about the session reaches the browser.
 */
export default async function FlagDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;

  let flag: Flag;
  let audit: AuditEntry[] = [];

  try {
    // One round trip each; the audit is small and bounded by the API's limit.
    [flag, audit] = await Promise.all([getFlag(key), getFlagAudit(key)]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    if (err instanceof ApiUnreachableError) {
      return (
        <Shell>
          <ErrorPanel
            title="The flag service is unreachable"
            message="This flag could not be loaded. Any apps already running keep serving their last known values."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href={`/flags/${key}`}>Try again</Link>
              </Button>
            }
          />
        </Shell>
      );
    }
    throw err;
  }

  return (
    <Shell>
      <FlagEditor flag={flag} />
      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Change history
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Every change is recorded in the same transaction as the change itself.
        </p>
        <div className="mt-4">
          <AuditTimeline entries={audit} />
        </div>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/flags"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        All flags
      </Link>
      {children}
    </div>
  );
}
