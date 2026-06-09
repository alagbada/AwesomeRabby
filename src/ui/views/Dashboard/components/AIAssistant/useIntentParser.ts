import { useCallback, useRef, useState } from 'react';
import type { IntentChain, ParsedIntent, ParseStage } from './intentTypes';

// ─── Chrome storage helper ────────────────────────────────────────────────────

function getStorage(keys: string[]): Promise<Record<string, any>> {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// ─── Get the rabby-api base URL ───────────────────────────────────────────────

async function getApiBase(): Promise<string> {
  const data = await getStorage(['awesome_api_url']);
  return (data.awesome_api_url as string | undefined) ?? 'http://localhost:3000';
}

// ─── Parse Groq JSON response ─────────────────────────────────────────────────

function parseGroqResponse(raw: string, chain: string): ParsedIntent {
  const data   = JSON.parse(raw);
  const txList = Array.isArray(data.transactions) ? data.transactions : [data];
  const tx     = txList[0];
  if (!tx?.action) {
    throw new Error('Could not understand that. Try: "Send 0.1 ETH to vitalik.eth"');
  }
  return {
    action:         tx.action           || 'unknown',
    chain:          tx.chain            || chain || 'ethereum',
    token:          tx.token            ?? null,
    amount:         tx.amount           ?? null,
    toAddress:      tx.toAddress        ?? null,
    toName:         tx.toName           ?? null,
    fromToken:      tx.fromToken        ?? null,
    toToken:        tx.toToken          ?? null,
    spenderAddress: tx.spenderAddress   ?? null,
    summary:        tx.summary          || '',
    confidence:     typeof tx.confidence === 'number' ? tx.confidence : 0.8,
    missingInfo:    Array.isArray(tx.missingInfo) ? tx.missingInfo : [],
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useIntentParser() {
  const [stage,  setStage]  = useState<ParseStage>('idle');
  const [intent, setIntent] = useState<ParsedIntent | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const lastParseRef = useRef(0);

  // ── Parse ─────────────────────────────────────────────────────────────────────

  const parse = useCallback(
    async (text: string, chain: IntentChain = 'ethereum') => {
      if (!text.trim()) return;

      // 2-second debounce between requests
      const now = Date.now();
      if (now - lastParseRef.current < 2000) {
        setError('Please wait a moment between requests.');
        setStage('error');
        return;
      }
      lastParseRef.current = now;

      setStage('parsing');
      setError(null);
      setIntent(null);

      try {
        const base = await getApiBase();
        const res = await fetch(`${base}/v1/ai/parse`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text, chain }),
        });

        if (!res.ok) {
          const errBody: any = await res.json().catch(() => ({}));
          if (res.status === 503) throw new Error('AI service is unavailable. Please try again later.');
          throw new Error(errBody?.error ?? `AI error ${res.status}`);
        }

        const json: any = await res.json();
        const parsed = parseGroqResponse(json.result, chain);
        setIntent(parsed);
        setStage('preview');

      } catch (e: any) {
        setError(e?.message ?? 'Parse failed');
        setStage('error');
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setStage('idle');
    setIntent(null);
    setError(null);
  }, []);

  return { stage, intent, error, parse, reset };
}
