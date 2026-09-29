import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-card border border-border-subtle bg-surface', className)}
      {...props}
    />
  );
}

const badgeTones = {
  on: 'bg-success-soft text-success',
  off: 'bg-canvas text-ink-muted',
  brand: 'bg-brand-soft text-brand',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-canvas text-ink-muted',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.ComponentProps<'span'> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A non-blocking error panel — the API being down must never blank the page. */
export function ErrorPanel({ title, message, action }: { title: string; message: string; action?: React.ReactNode }) {
  return (
    <Card className="border-danger/30 bg-danger-soft/40 p-6" role="alert">
      <h2 className="text-sm font-semibold text-danger">{title}</h2>
      <p className="mt-1 text-sm text-ink-muted">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}
