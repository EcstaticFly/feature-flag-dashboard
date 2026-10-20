import { FlagProvider } from 'flagpilot/react';
import type { Metadata } from 'next';
import { flagBootstrap } from '@/lib/flagpilot.server';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'flagpilot · Next.js example',
};

/**
 * A server component. It works out who the user is, asks the server SDK for
 * that user's browser flags and a signed identity, and hands both to
 * <FlagProvider> — which is a client component ("use client" is built into
 * flagpilot/react), so it can be rendered straight from here.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const { initialFlags, signedContext } = await flagBootstrap(user);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: 640, padding: '0 1rem' }}>
        <FlagProvider
          apiUrl={process.env.FLAGPILOT_API_URL ?? 'http://localhost:4000'}
          clientKey={process.env.FLAGPILOT_CLIENT_KEY ?? ''}
          initialFlags={initialFlags}
          signedContext={signedContext}
        >
          {children}
        </FlagProvider>
      </body>
    </html>
  );
}
