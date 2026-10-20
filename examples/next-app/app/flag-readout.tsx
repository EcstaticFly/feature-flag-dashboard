'use client';

import { useFlag, useFlagClient, useFlagStatus } from 'flagpilot/react';

/** The browser's view of the flag. Its first render uses the server's initialFlags. */
export function FlagReadout({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  const status = useFlagStatus();
  const client = useFlagClient();

  return (
    <>
      <tr>
        <th style={cell}>Client component (useFlag)</th>
        <td style={cell} data-testid="browser-value">
          {String(value)}
        </td>
      </tr>
      <tr>
        <th style={cell}>Browser SDK status</th>
        <td style={cell}>
          <span data-testid="browser-status">{status.state}</span>{' '}
          {/* Normally values refresh on their own (every minute, and when the tab regains focus). */}
          <button type="button" onClick={() => void client?.refresh()}>
            Check now
          </button>
        </td>
      </tr>
    </>
  );
}

const cell = { border: '1px solid #ccc', padding: '0.4rem 0.8rem', textAlign: 'left' } as const;
