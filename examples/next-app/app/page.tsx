import { isEnabled } from 'flagpilot';
import { flagsReady } from '@/lib/flagpilot.server';
import { currentUser, DEMO_USERS } from '@/lib/session';
import { signIn, signOut } from './actions';
import { FlagReadout } from './flag-readout';

/**
 * One flag, checked both ways:
 *
 * - here, in a server component, with the server SDK (`isEnabled`), and
 * - in <FlagReadout>, a client component, with `useFlag` from flagpilot/react.
 *
 * For the browser value to appear, turn on "Available to browser SDKs" for the
 * flag in the dashboard. Pick another flag with ?flag=<key>.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { flag } = await searchParams;
  const flagKey = typeof flag === 'string' && flag !== '' ? flag : 'new-checkout-flow';
  const user = await currentUser();

  await flagsReady();
  // No context for a visitor: anonymous traffic sees an enabled flag in full.
  const serverValue = user ? isEnabled(flagKey, { userId: user }) : isEnabled(flagKey);

  return (
    <main>
      <h1>flagpilot · Next.js</h1>
      <p>
        Flag <code>{flagKey}</code>, for{' '}
        <strong data-testid="user">{user ?? 'a visitor (not signed in)'}</strong>
      </p>

      <table style={{ borderCollapse: 'collapse', margin: '1rem 0' }}>
        <tbody>
          <tr>
            <th style={cell}>Server component (isEnabled)</th>
            <td style={cell} data-testid="server-value">
              {String(serverValue)}
            </td>
          </tr>
          <FlagReadout flagKey={flagKey} />
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {DEMO_USERS.map((name) => (
          <form key={name} action={signIn}>
            <input type="hidden" name="user" value={name} />
            <button type="submit" disabled={user === name}>
              Sign in as {name}
            </button>
          </form>
        ))}
        <form action={signOut}>
          <button type="submit" disabled={user === null}>
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

const cell = { border: '1px solid #ccc', padding: '0.4rem 0.8rem', textAlign: 'left' } as const;
