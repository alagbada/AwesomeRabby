// ─── AI Intent Types ─────────────────────────────────────────────────────────

export type IntentAction = 'send' | 'swap' | 'approve' | 'bridge' | 'fund' | 'unknown';

export type IntentChain =
  | 'ethereum'
  | 'base'
  | 'polygon'
  | 'arbitrum'
  | 'optimism'
  | 'avalanche'
  | 'bsc';

export interface ParsedIntent {
  action: IntentAction;
  chain: IntentChain;
  /** Uppercase ticker, e.g. "ETH", "USDC" */
  token: string | null;
  amount: number | null;
  /** 0x address or ENS name */
  toAddress: string | null;
  /** Human name if the user said "send to Alice" */
  toName: string | null;
  /** Swap: token being sold */
  fromToken: string | null;
  /** Swap: token being received */
  toToken: string | null;
  /** Approve: contract being approved */
  spenderAddress: string | null;
  /** One-sentence plain English description */
  summary: string;
  /** 0–1 */
  confidence: number;
  /** Field names that are missing/ambiguous */
  missingInfo: string[];
}

export type ParseStage = 'idle' | 'parsing' | 'preview' | 'error';
