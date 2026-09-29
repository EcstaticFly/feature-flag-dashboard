'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, ApiUnreachableError, apiFetch } from '@/lib/api';
import type { ActionState } from '@/lib/action-state';
import type { TargetingRule } from '@/lib/flags';

/**
 * Every mutation the dashboard makes.
 *
 * Actions RETURN failures rather than throwing: a thrown error in a Server
 * Action gives the user a blank error page, whereas returned state renders as
 * an inline message with their input preserved.
 */

/** Turns an API failure into something a person can act on. */
function toActionState(err: unknown): ActionState {
  if (err instanceof ApiUnreachableError) {
    return { ok: false, error: 'The flag service is unreachable. Your change was not saved.' };
  }

  if (err instanceof ApiError) {
    if (err.code === 'flag_key_exists') {
      return {
        ok: false,
        error: 'That key is already taken.',
        fieldErrors: { key: 'A flag with this key already exists.' },
      };
    }
    if (err.code === 'validation_error') {
      const fieldErrors = err.fieldErrors();
      return {
        ok: false,
        error: Object.keys(fieldErrors).length ? 'Please fix the highlighted fields.' : err.message,
        fieldErrors,
      };
    }
    if (err.code === 'flag_not_found') {
      return { ok: false, error: 'That flag no longer exists. It may have been deleted.' };
    }
    return { ok: false, error: err.message };
  }

  // A `redirect()` from the API helper throws a control-flow signal that must
  // bubble, not be swallowed as a failure.
  throw err;
}

function parseRules(raw: FormDataEntryValue | null): TargetingRule[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as TargetingRule[]) : [];
}

function revalidateFlag(key?: string): void {
  revalidatePath('/flags');
  if (key) revalidatePath(`/flags/${key}`);
}

export async function createFlagAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const key = String(formData.get('key') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  try {
    await apiFetch('/api/flags', {
      method: 'POST',
      body: JSON.stringify({
        key,
        name,
        description: description || null,
        enabled: formData.get('enabled') === 'on',
        rolloutPercentage: Number(formData.get('rolloutPercentage') ?? 0),
        targetingRules: parseRules(formData.get('targetingRules')),
      }),
    });
  } catch (err) {
    // Hand the input back so a rejected create doesn't make them retype it.
    return { ...toActionState(err), values: { key, name, description } };
  }

  // Outside the try: redirect() signals by throwing, and catching it here would
  // turn a successful create into an error message.
  revalidateFlag(key);
  redirect(`/flags/${key}`);
}

export async function updateFlagAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const key = String(formData.get('key') ?? '');

  try {
    await apiFetch(`/api/flags/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: String(formData.get('name') ?? '').trim(),
        description: String(formData.get('description') ?? '').trim() || null,
        enabled: formData.get('enabled') === 'on',
        rolloutPercentage: Number(formData.get('rolloutPercentage') ?? 0),
        targetingRules: parseRules(formData.get('targetingRules')),
      }),
    });
  } catch (err) {
    return toActionState(err);
  }

  revalidateFlag(key);
  return { ok: true };
}

/** The kill switch, straight from the list. */
export async function toggleFlagAction(key: string, enabled: boolean): Promise<ActionState> {
  try {
    await apiFetch(`/api/flags/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  } catch (err) {
    return toActionState(err);
  }

  revalidateFlag(key);
  return { ok: true };
}

export async function deleteFlagAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const key = String(formData.get('key') ?? '');

  try {
    await apiFetch(`/api/flags/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      parseJson: false,
    });
  } catch (err) {
    return toActionState(err);
  }

  revalidateFlag(key);
  redirect('/flags');
}
