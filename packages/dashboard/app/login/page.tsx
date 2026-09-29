'use client';

import { Flag, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const expired = params.get('expired') === '1';
  const next = params.get('next') ?? '/flags';

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    try {
      // Posts to our own Route Handler, not the Express API: it sets the JWT as
      // an httpOnly cookie so this page never handles the token itself.
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'could not sign in');
        setPending(false);
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError('the dashboard could not reach the server');
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm p-8 shadow-sm">
      <div className="mb-7 flex flex-col items-center text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-white">
          <Flag className="h-5 w-5" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Feature Flags</h1>
        <p className="mt-1 text-sm text-ink-muted">Sign in to manage your rollouts.</p>
      </div>

      {expired && (
        <p
          role="status"
          className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-xs text-ink-muted"
        >
          Your session expired. Please sign in again.
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            placeholder="admin@example.com"
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
