// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FlagProvider, useFlag, useFlagStatus } from 'flagpilot/react';

/*
 * Server rendering — what Next.js does with every client component. There is
 * no window here. The provider must render without a request or a timer,
 * hooks must answer from initialFlags, and nothing may throw (React 18+
 * throws during SSR if useSyncExternalStore has no getServerSnapshot).
 */

function Page() {
  return (
    <p>
      beta={String(useFlag('beta'))} missing={String(useFlag('missing', true))} status={useFlagStatus().state}
    </p>
  );
}

describe('server rendering', () => {
  it('renders the server snapshot without touching the network', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const html = renderToString(
        <FlagProvider apiUrl="https://flags.example.com" clientKey="public-client-key-123" initialFlags={{ beta: true }}>
          <Page />
        </FlagProvider>,
      );
      expect(html).toContain('beta=<!-- -->true');
      expect(html).toContain('missing=<!-- -->true');
      expect(html).toContain('status=<!-- -->idle');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders defaults when there are no initialFlags', () => {
    const html = renderToString(
      <FlagProvider apiUrl="https://flags.example.com" clientKey="public-client-key-123">
        <Page />
      </FlagProvider>,
    );
    expect(html).toContain('beta=<!-- -->false');
  });
});
