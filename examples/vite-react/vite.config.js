import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The signer (server.mjs) stands in for your backend's session endpoint.
const proxy = { '/session': 'http://localhost:5180' };

export default defineConfig({
  // plugin-react also sets resolve.dedupe for react and react-dom. That matters
  // in this monorepo only: flagpilot is linked from packages/sdk, next to the
  // React 19 the SDK's own tests use, while this app is on React 18. The e2e
  // suite checks the bundle holds a single React 18. An app installing
  // flagpilot from npm cannot hit this — React is a peer dependency.
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
});
