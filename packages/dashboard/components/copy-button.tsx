'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Copies `text`. Without clipboard access (a non-https origin, a denied permission) it says so. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2000);
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={label}>
      {state === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
    </Button>
  );
}
