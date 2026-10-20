import { ArrowLeft, Globe, Server, TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { API_URL, ApiError, ApiUnreachableError } from '@/lib/api';
import { getSdkSettings, type SdkSettings } from '@/lib/flags';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Badge, Card, ErrorPanel } from '@/components/ui/misc';

export const metadata: Metadata = { title: 'SDK setup · Feature Flags' };

/**
 * How to connect apps: the server SDK, and the browser SDKs.
 *
 * Shows only what is safe on a screen. The browser client key is public by
 * design (it ships in every page that uses it). The SDK key is a secret, and
 * the API never returns it — this page only knows that one is configured.
 */
export default async function SdkSettingsPage() {
  let settings: SdkSettings | null = null;
  let problem: 'unreachable' | 'outdated' | null = null;

  try {
    settings = await getSdkSettings();
  } catch (err) {
    if (err instanceof ApiUnreachableError) problem = 'unreachable';
    // A flag service older than this dashboard has no settings endpoint.
    else if (err instanceof ApiError && err.status === 404) problem = 'outdated';
    else throw err;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/flags"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        All flags
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">SDK setup</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Check flags from your servers with <code className="text-xs">flagpilot</code>, and from
        browsers with <code className="text-xs">flagpilot/browser</code> or{' '}
        <code className="text-xs">flagpilot/react</code>. One install:{' '}
        <code className="rounded bg-surface px-1.5 py-0.5 text-xs">npm install flagpilot</code>
      </p>

      <div className="mt-8 space-y-6">
        {problem === 'unreachable' && (
          <ErrorPanel
            title="The flag service is unreachable"
            message="The SDK settings could not be loaded. Apps already running keep serving their last known values."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/settings/sdk">Try again</Link>
              </Button>
            }
          />
        )}
        {problem === 'outdated' && (
          <ErrorPanel
            title="The flag service needs updating"
            message="It does not have the SDK settings endpoint yet. Deploy the latest API, then reload this page."
          />
        )}
        {settings && <Settings settings={settings} />}
      </div>
    </div>
  );
}

function Settings({ settings }: { settings: SdkSettings }) {
  const browser = settings.browserSdk;
  const clientKey = browser.clientKey ?? '';

  return (
    <>
      <Card className="divide-y divide-border-subtle">
        <SectionHeader
          icon={<Server className="h-4 w-4" />}
          title="Server SDK"
          badge={<Badge tone="on">Configured</Badge>}
        >
          Your servers authenticate with the SDK key (<Env>SDK_API_KEY</Env> on the flag service).
          It is a secret, so it is never shown here. Keep it in your server&apos;s environment, never
          in browser code. If it ever reaches a browser, rotate it.
        </SectionHeader>
        <Snippet title="Node / Express" code={serverSnippet()} />
      </Card>

      <Card className="divide-y divide-border-subtle">
        <SectionHeader
          icon={<Globe className="h-4 w-4" />}
          title="Browser SDKs"
          badge={browser.enabled ? <Badge tone="on">On</Badge> : <Badge tone="off">Off</Badge>}
        >
          Browsers only ever receive on/off values, and only for flags marked{' '}
          <em>Available to browser SDKs</em>. Rules, percentages and allowlists stay on the server.
        </SectionHeader>

        {!browser.enabled ? (
          <p className="p-5 text-sm text-ink-muted">
            To turn this on, set <Env>CLIENT_API_KEY</Env> (a new random value, not one of your
            secrets) and <Env>CLIENT_ALLOWED_ORIGINS</Env> (the sites allowed to use it, such as{' '}
            <code className="text-xs">https://app.example.com</code>) on the flag service, then
            restart it.
          </p>
        ) : (
          <>
            <Row label="Client key" hint="Public by design: it ships in your page's JavaScript.">
              <div className="flex items-center gap-2">
                <code
                  data-testid="client-key"
                  className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 text-xs"
                >
                  {clientKey}
                </code>
                <CopyButton text={clientKey} label="Copy client key" />
              </div>
            </Row>

            <Row
              label="Allowed sites"
              hint="Only pages on these origins can use the client key. Change with CLIENT_ALLOWED_ORIGINS."
            >
              {browser.allowedOrigins === '*' ? (
                <Warning>
                  <code className="text-xs">*</code> — any website can call the browser API with
                  this key. List your sites instead.
                </Warning>
              ) : (
                <ul className="space-y-1" data-testid="allowed-origins">
                  {browser.allowedOrigins.map((origin) => (
                    <li key={origin}>
                      <code className="rounded bg-canvas px-2 py-0.5 text-xs">{origin}</code>
                    </li>
                  ))}
                </ul>
              )}
            </Row>

            <Row
              label="Signed identities"
              hint="Change with CLIENT_REQUIRE_SIGNED_CONTEXT."
            >
              {browser.requireSignedContext ? (
                <p className="text-sm">
                  <Badge tone="on">Required</Badge>{' '}
                  <span className="text-ink-muted">
                    A signed-in user&apos;s identity must come from your server&apos;s{' '}
                    <code className="text-xs">signContext()</code>, so a visitor cannot claim to be
                    someone else.
                  </span>
                </p>
              ) : (
                <Warning>
                  Not required — a visitor can send any user id and see that user&apos;s browser
                  flags. Fine for a demo; turn it on for real users.
                </Warning>
              )}
            </Row>

            <Snippet title="React (Vite, Create React App)" code={reactSnippet(clientKey)} />
            <Snippet title="Next.js (App Router)" code={nextSnippet(clientKey)} />
            <Snippet title="Any other framework, or none" code={vanillaSnippet(clientKey)} />
          </>
        )}
      </Card>
    </>
  );
}

function SectionHeader({
  icon,
  title,
  badge,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  badge: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
            {icon}
          </span>
          {title}
        </h2>
        {badge}
      </div>
      <p className="mt-2 text-sm text-ink-muted">{children}</p>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 p-5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <CopyButton text={code} label={`Copy the ${title} example`} />
      </div>
      <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-ink">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Env({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-canvas px-1 py-0.5 text-xs">{children}</code>;
}

/*
 * Snippets. The SDK key is always an environment variable placeholder — this
 * page never has it, and a snippet must never invite pasting it into code.
 */

function serverSnippet(): string {
  return `import { init, isEnabled, signContext } from 'flagpilot';

// Once, at startup. Never throws: if the flag service is down,
// flags serve their defaults until it is back.
await init({ apiUrl: '${API_URL}', apiKey: process.env.FLAGPILOT_SDK_KEY });

if (isEnabled('new-checkout-flow', { userId: user.id })) {
  // the new code path
}

// For browser SDKs: who the user is, signed so it can't be faked.
// Send it to the page (e.g. in your session response).
const flagToken = await signContext({ userId: user.id });`;
}

function reactSnippet(clientKey: string): string {
  return `import { FlagProvider, useFlag } from 'flagpilot/react';

// Near the root. flagToken comes from your server's signContext();
// leave it out for visitors who aren't signed in.
<FlagProvider
  apiUrl="${API_URL}"
  clientKey="${clientKey}"
  signedContext={session?.flagToken}
>
  <App />
</FlagProvider>

// Anywhere below it:
function Navbar() {
  const newTitle = useFlag('new-navbar-title');
  return <h1>{newTitle ? 'New title' : 'Old title'}</h1>;
}`;
}

function nextSnippet(clientKey: string): string {
  return `// app/layout.tsx — a server component
import { getClientFlags, init, signContext } from 'flagpilot';
import { FlagProvider } from 'flagpilot/react';

const ready = init({
  apiUrl: process.env.FLAGPILOT_API_URL!,
  apiKey: process.env.FLAGPILOT_SDK_KEY!,
});

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ready;
  const user = await getCurrentUser(); // your auth
  const context = user ? { userId: user.id } : {};
  return (
    <html lang="en">
      <body>
        <FlagProvider
          apiUrl="${API_URL}"
          clientKey="${clientKey}"
          initialFlags={getClientFlags(context)}
          signedContext={user ? (await signContext(context)) ?? undefined : undefined}
        >
          {children}
        </FlagProvider>
      </body>
    </html>
  );
}

// In a client component ('use client'): const on = useFlag('new-navbar-title');
// In a server component: isEnabled('new-navbar-title', { userId: user.id })`;
}

function vanillaSnippet(clientKey: string): string {
  return `import { createBrowserClient } from 'flagpilot/browser';

const flags = createBrowserClient({
  apiUrl: '${API_URL}',
  clientKey: '${clientKey}',
  signedContext: flagToken, // from your server's signContext(), if signed in
});

render();
flags.subscribe(render); // called whenever a value changes

function render() {
  document.title = flags.isEnabled('new-navbar-title') ? 'New title' : 'Old title';
}`;
}
