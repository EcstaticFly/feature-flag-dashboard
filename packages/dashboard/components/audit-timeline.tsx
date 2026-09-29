import { Bot, PenLine, Plus, Trash2 } from 'lucide-react';
import { RelativeTime } from '@/components/relative-time';
import { Badge, Card } from '@/components/ui/misc';
import type { AuditEntry, Flag } from '@/lib/flags';

/**
 * The audit trail for one flag (FR-06).
 *
 * The point is answering "who turned this off at 2am, and what was it before?" —
 * so each entry shows the fields that actually changed, old value to new, and
 * distinguishes a human from the integration endpoint.
 */

const ACTIONS = {
  create: { icon: Plus, label: 'created', tone: 'on' },
  update: { icon: PenLine, label: 'updated', tone: 'brand' },
  delete: { icon: Trash2, label: 'deleted', tone: 'danger' },
} as const;

/** Fields worth showing a diff for; ids and timestamps are noise here. */
const TRACKED: (keyof Flag)[] = [
  'enabled',
  'rolloutPercentage',
  'name',
  'description',
  'targetingRules',
];

const LABELS: Partial<Record<keyof Flag, string>> = {
  enabled: 'Enabled',
  rolloutPercentage: 'Rollout',
  name: 'Name',
  description: 'Description',
  targetingRules: 'Targeting rules',
};

function display(field: keyof Flag, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'enabled') return value ? 'on' : 'off';
  if (field === 'rolloutPercentage') return `${value as number}%`;
  if (field === 'targetingRules') {
    const rules = value as Flag['targetingRules'];
    if (!rules?.length) return 'none';
    return rules.map((r) => `${r.attribute} ${r.operator} [${r.values.join(', ')}]`).join('; ');
  }
  return String(value);
}

function changes(entry: AuditEntry): { field: keyof Flag; from: string; to: string }[] {
  const { oldValue, newValue } = entry;
  if (!oldValue || !newValue) return [];

  return TRACKED.filter(
    (field) => JSON.stringify(oldValue[field]) !== JSON.stringify(newValue[field]),
  ).map((field) => ({
    field,
    from: display(field, oldValue[field]),
    to: display(field, newValue[field]),
  }));
}

export function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card className="px-5 py-8 text-center text-sm text-ink-muted">
        No changes recorded yet.
      </Card>
    );
  }

  return (
    <Card className="divide-y divide-border-subtle">
      {entries.map((entry) => {
        const meta = ACTIONS[entry.action];
        const Icon = meta.icon;
        const diff = changes(entry);
        // The integration endpoint (Milestone 6) writes entries too.
        const isSystem = entry.actor === 'system:integration';

        return (
          <article key={entry.id} className="flex gap-3 p-4">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-muted">
              {isSystem ? <Bot className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <span className="truncate font-medium" title={entry.actorLabel}>
                  {entry.actorLabel}
                </span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <RelativeTime iso={entry.createdAt} className="text-xs text-ink-muted" />
              </div>

              {diff.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {diff.map(({ field, from, to }) => (
                    <li key={field} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                      <span className="text-ink-muted">{LABELS[field] ?? field}</span>
                      <span className="max-w-60 truncate rounded bg-canvas px-1.5 py-0.5 text-ink-muted line-through">
                        {from}
                      </span>
                      <span className="text-ink-muted">→</span>
                      <span className="max-w-60 truncate rounded bg-brand-soft px-1.5 py-0.5 font-medium text-brand">
                        {to}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {entry.action === 'create' && entry.newValue && (
                <p className="mt-1 text-xs text-ink-muted">
                  Created {display('enabled', entry.newValue.enabled)} at{' '}
                  {display('rolloutPercentage', entry.newValue.rolloutPercentage)}.
                </p>
              )}
            </div>
          </article>
        );
      })}
    </Card>
  );
}
