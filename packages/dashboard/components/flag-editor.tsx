'use client';

import { Check, Loader2, Trash2 } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';
import { deleteFlagAction, updateFlagAction } from '@/app/actions/flags';
import { IDLE } from '@/lib/action-state';
import { RelativeTime } from '@/components/relative-time';
import { RuleBuilder } from '@/components/rule-builder';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Label, Textarea } from '@/components/ui/field';
import { Badge, Card } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import type { Flag } from '@/lib/flags';

export function FlagEditor({ flag }: { flag: Flag }) {
  const [state, formAction, pending] = useActionState(updateFlagAction, IDLE);
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState(flag.rolloutPercentage);
  const [name, setName] = useState(flag.name);
  const [description, setDescription] = useState(flag.description ?? '');

  /*
   * Re-seed every field from the server record whenever it changes.
   *
   * React resets a form once its action resolves, and Radix's Switch listens
   * for that reset and drives its controlled value back to `defaultChecked` —
   * so without this, saving "enabled: on" left the switch visibly off until a
   * manual reload. `revalidatePath` in the action re-renders this page with the
   * saved values, and `updatedAt` changing is the signal that they are new.
   */
  useEffect(() => {
    setEnabled(flag.enabled);
    setRollout(flag.rolloutPercentage);
    setName(flag.name);
    setDescription(flag.description ?? '');
  }, [flag.updatedAt, flag.enabled, flag.rolloutPercentage, flag.name, flag.description]);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="key" value={flag.key} />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight" title={flag.name}>
            {flag.name}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <code className="rounded bg-canvas px-1.5 py-0.5 text-xs">{flag.key}</code>
            {flag.lastUpdatedAt && (
              <span className="truncate">
                updated by {flag.lastUpdatedBy} <RelativeTime iso={flag.lastUpdatedAt} />
              </span>
            )}
          </div>
        </div>
        <Badge tone={enabled ? 'on' : 'off'}>{enabled ? 'Live' : 'Off'}</Badge>
      </header>

      <Card className="divide-y divide-border-subtle">
        <div className="flex items-center justify-between gap-4 p-5">
          <div>
            <Label htmlFor="enabled">Enabled</Label>
            <p className="mt-0.5 text-sm text-ink-muted">
              The kill switch. Turning this off hides the feature from everyone, allowlists
              included.
            </p>
          </div>
          {/*
            Deliberately no `name` on the Switch: Radix would then render its own
            hidden checkbox that resets with the form. The hidden input below
            carries the value instead, driven purely by React state.
          */}
          <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
          {enabled && <input type="hidden" name="enabled" value="on" />}
        </div>

        <div className="space-y-3 p-5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="rolloutPercentage">Rollout</Label>
            <span className="text-sm font-medium tabular-nums">{rollout}%</span>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={0}
              max={100}
              value={rollout}
              onChange={(event) => setRollout(Number(event.target.value))}
              aria-label="Rollout percentage slider"
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border-subtle accent-brand"
            />
            <Input
              id="rolloutPercentage"
              name="rolloutPercentage"
              type="number"
              min={0}
              max={100}
              value={rollout}
              onChange={(event) =>
                setRollout(Math.max(0, Math.min(100, Number(event.target.value) || 0)))
              }
              className="w-20"
              aria-invalid={Boolean(state.fieldErrors?.rolloutPercentage)}
            />
          </div>
          <p className="text-xs text-ink-muted">
            Users are bucketed deterministically, so raising this only ever adds people — nobody
            already in the rollout is removed.
            {!enabled && ' The kill switch is off, so nobody sees the feature at any percentage.'}
          </p>
          {state.fieldErrors?.rolloutPercentage && (
            <p role="alert" className="text-xs font-medium text-danger">
              {state.fieldErrors.rolloutPercentage}
            </p>
          )}
        </div>

        <div className="space-y-3 p-5">
          <div>
            <Label>Targeting rules</Label>
            <p className="mt-0.5 text-sm text-ink-muted">
              A matching rule wins over the percentage, so you can let specific people in first.
            </p>
          </div>
          <RuleBuilder
            key={flag.updatedAt}
            name="targetingRules"
            initial={flag.targetingRules ?? []}
          />
          {state.fieldErrors?.targetingRules && (
            <p role="alert" className="text-xs font-medium text-danger">
              {state.fieldErrors.targetingRules}
            </p>
          )}
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Name" htmlFor="name" error={state.fieldErrors?.name}>
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field label="Description" htmlFor="description" error={state.fieldErrors?.description}>
            <Textarea
              id="description"
              name="description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </Card>

      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <DeleteFlagDialog flagKey={flag.key} />

        <div className="flex items-center gap-3">
          {state.ok && !pending && (
            <span className="flex items-center gap-1.5 text-sm text-success" role="status">
              <Check className="h-4 w-4" />
              Saved
            </span>
          )}
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}

function DeleteFlagDialog({ flagKey }: { flagKey: string }) {
  const [state, formAction, pending] = useActionState(deleteFlagAction, IDLE);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="dangerGhost" size="sm">
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Delete ${flagKey}?`}
        description="Apps still calling isEnabled() for this key will fall back to their default. The change history is kept, and the key can be reused later."
      >
        {/* Nested inside the editor form is not allowed, so this is its own form. */}
        <form action={formAction} className="flex justify-end gap-2">
          <input type="hidden" name="key" value={flagKey} />
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" variant="danger" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete flag
          </Button>
        </form>
        {state.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {state.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
