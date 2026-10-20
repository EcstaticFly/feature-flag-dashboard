import { FlagProvider, useFlag, useFlagClient, useFlagStatus } from 'flagpilot/react';
import { useState, version as reactVersion } from 'react';

/**
 * A single-page app — no server rendering — using flagpilot/react.
 *
 * The browser only ever holds the public client key. Who the user is comes from
 * this app's own backend (here, server.mjs) as a signed token; the browser
 * passes it along but cannot forge or alter it.
 */

const API_URL = import.meta.env.VITE_FLAGPILOT_API_URL ?? 'http://localhost:4000';
const CLIENT_KEY = import.meta.env.VITE_FLAGPILOT_CLIENT_KEY ?? '';
const FLAG_KEY = new URLSearchParams(window.location.search).get('flag') || 'new-checkout-flow';

const SIGNED_OUT = { user: null, flagToken: undefined };

export function App() {
  const [session, setSession] = useState(SIGNED_OUT);

  async function signIn(user) {
    try {
      // Your real login/session endpoint would return the token alongside the user.
      const response = await fetch(`/session?user=${encodeURIComponent(user)}`);
      const body = await response.json();
      setSession({ user: body.user, flagToken: body.flagToken ?? undefined });
    } catch {
      setSession(SIGNED_OUT);
    }
  }

  return (
    // persist: the last values survive a reload, so a returning visitor sees the
    // right UI even before the network answers (or if it never does).
    <FlagProvider apiUrl={API_URL} clientKey={CLIENT_KEY} signedContext={session.flagToken} options={{ persist: true }}>
      <h1>flagpilot · Vite + React</h1>
      <p>
        React <code data-testid="react-version">{reactVersion}</code>. Flag <code>{FLAG_KEY}</code>, for{' '}
        <strong data-testid="user">{session.user ?? 'a visitor (not signed in)'}</strong>
      </p>
      <Readout />
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => signIn('alice')} disabled={session.user === 'alice'}>
          Sign in as alice
        </button>
        <button type="button" onClick={() => signIn('heidi')} disabled={session.user === 'heidi'}>
          Sign in as heidi
        </button>
        <button type="button" onClick={() => setSession(SIGNED_OUT)} disabled={session.user === null}>
          Sign out
        </button>
      </div>
    </FlagProvider>
  );
}

function Readout() {
  const value = useFlag(FLAG_KEY);
  const status = useFlagStatus();
  const client = useFlagClient();

  return (
    <p>
      useFlag → <strong data-testid="browser-value">{String(value)}</strong> · status{' '}
      <span data-testid="browser-status">{status.state}</span>{' '}
      <button type="button" onClick={() => void client?.refresh()}>
        Check now
      </button>
    </p>
  );
}
