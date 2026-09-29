'use client';

import { Loader2, Plus } from 'lucide-react';
import { useActionState, useState } from 'react';
import { createFlagAction } from '@/app/actions/flags';
import { IDLE } from '@/lib/action-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';

/**
 * Create a flag.
 *
 * New flags start disabled at 0% on purpose: ship the code dark, then roll it
 * out deliberately from the detail page.
 */
export function CreateFlagDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createFlagAction, IDLE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          New flag
        </Button>
      </DialogTrigger>

      <DialogContent
        title="Create a flag"
        description="It starts turned off at 0%, so deploying the code changes nothing until you say so."
      >
        <form action={formAction} className="space-y-4">
          <Field
            label="Key"
            htmlFor="key"
            hint="Lowercase letters, numbers and hyphens. Your code will reference this."
            error={state.fieldErrors?.key}
          >
            <Input
              id="key"
              name="key"
              required
              autoFocus
              defaultValue={state.values?.key ?? ''}
              placeholder="new-checkout-flow"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              aria-invalid={Boolean(state.fieldErrors?.key)}
            />
          </Field>

          <Field label="Name" htmlFor="name" error={state.fieldErrors?.name}>
            <Input
              id="name"
              name="name"
              required
              defaultValue={state.values?.name ?? ''}
              placeholder="New checkout flow"
              aria-invalid={Boolean(state.fieldErrors?.name)}
            />
          </Field>

          <Field
            label="Description"
            htmlFor="description"
            hint="Optional. What is this flag protecting?"
            error={state.fieldErrors?.description}
          >
            <Textarea
              id="description"
              name="description"
              rows={2}
              defaultValue={state.values?.description ?? ''}
            />
          </Field>

          {state.error && !state.fieldErrors?.key && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create flag
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
