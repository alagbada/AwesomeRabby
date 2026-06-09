/**
 * useIntentExecutor
 *
 * Takes a ParsedIntent and moves it all the way to a signed transaction
 * without touching any navigation or existing UI pages.
 *
 * Stages:
 *   idle → building → ready → signing → success
 *                  ↘ error (recoverable — reset() brings back to idle)
 *
 * Supported actions:
 *   swap  — fetches 1inch quote + builds calldata via rabby-api /v1/swap/*
 *   send  — builds native or ERC-20 transfer calldata locally
 *   (bridge and fund are stubs — extend as those routes mature)
 */

import { useState, useCallback } from 'react';
import type { ParsedIntent } from './intentTypes';
import { AWESOME_API_URL } from '@/constant';

// ── Token registry ─────────────────────────────────────────────────────────────
// Maps chain slug + uppercase ticker → contract address.
// Native token on every chain uses the 1inch sentinel address.

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  ethereum: {
    ETH:  NATIVE,
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI:  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  bsc: {
    BNB:  NATIVE,
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  },
  polygon: {
    MATIC:  NATIVE,
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    USDC:   '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDT:   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI:    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
  },
  arbitrum: {
    ETH:  NATIVE,
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  optimism: {
    ETH:  NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
  base: {
    ETH:  NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  avalanche: {
    AVAX:  NATIVE,
    WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    USDC:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    USDT:  '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  },
};

// Decimals for human-readable → wei conversion
const TOKEN_DECIMALS: Record<string, Record<string, number>> = {
  ethereum:  { ETH: 18, WETH: 18, USDC: 6,  USDT: 6,  DAI: 18, WBTC: 8  },
  bsc:       { BNB: 18, WBNB: 18, USDC: 18, USDT: 18, BUSD: 18           },
  polygon:   { MATIC: 18, WMATIC: 18, USDC: 6, USDT: 6, DAI: 18          },
  arbitrum:  { ETH: 18, WETH: 18, USDC: 6,  USDT: 6                      },
  optimism:  { ETH: 18, WETH: 18, USDC: 6,  USDT: 6                      },
  base:      { ETH: 18, WETH: 18, USDC: 6                                 },
  avalanche: { AVAX: 18, WAVAX: 18, USDC: 6, USDT: 6                     },
};

function resolveTokenAddress(chain: string, ticker: string): string | null {
  return TOKEN_ADDRESSES[chain]?.[ticker.toUpperCase()] ?? null;
}

function resolveDecimals(chain: string, ticker: string): number {
  return TOKEN_DECIMALS[chain]?.[ticker.toUpperCase()] ?? 18;
}

/** Human-readable amount → raw wei string, BigInt-safe. */
function toWei(amount: number, decimals: number): string {
  const intPart  = BigInt(Math.floor(amount));
  const fracPart = amount - Math.floor(amount);
  const factor   = BigInt(10) ** BigInt(decimals);
  // Represent fraction as BigInt via 18-dp intermediate to avoid float noise
  const fracWei  = BigInt(Math.round(fracPart * Number(factor)));
  return (intPart * factor + fracWei).toString();
}

/** Raw wei string → human-readable, 6 significant decimals. */
function fromWei(wei: string, decimals: number): string {
  const val = Number(BigInt(wei)) / 10 ** decimals;
  return val.toLocaleString('en', { maximumFractionDigits: 6 });
}

// Ankr returns native-token contract_address as the blockchain name, not 0x…
const ANKR_BLOCKCHAIN: Record<string, string> = {
  ethereum: 'eth', bsc: 'bsc', polygon: 'polygon',
  arbitrum: 'arbitrum', optimism: 'optimism',
  avalanche: 'avalanche_c', base: 'base',
};

// ── rabby-api fetch helper ─────────────────────────────────────────────────────

async function getBase(): Promise<string> {
  let base = AWESOME_API_URL;
  try {
    const stored = await new Promise<Record<string, string>>((resolve) =>
      chrome.storage.local.get(['awesome_api_url'], resolve),
    );
    if (stored.awesome_api_url) base = stored.awesome_api_url;
  } catch { /* unit tests / non-extension context */ }
  return base;
}

async function apiGet<T>(path: string): Promise<T> {
  const base = await getBase();
  const res  = await fetch(`${base}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`rabby-api ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: object): Promise<T> {
  const base = await getBase();
  const res  = await fetch(`${base}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rabby-api ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Balance check ─────────────────────────────────────────────────────────────
//
// Fetches the on-chain balance for `ticker` on `chain` and throws a
// human-readable error if the wallet holds less than `amountWei`.

interface BalanceToken {
  contract_address:       string;
  contract_ticker_symbol: string;
  balance:                string; // raw integer string (wei / smallest unit)
}

async function assertSufficientBalance(
  chain:         string,
  walletAddress: string,
  ticker:        string,
  tokenAddr:     string | null,
  amountWei:     string,
  decimals:      number,
): Promise<void> {
  const isNative = !tokenAddr || tokenAddr.toLowerCase() === NATIVE.toLowerCase();
  const ankrName = ANKR_BLOCKCHAIN[chain];

  let tokens: BalanceToken[] = [];
  try {
    const data = await apiGet<{ ok: boolean; tokens: BalanceToken[] }>(
      `/v1/balance/${chain}/${walletAddress.toLowerCase()}`,
    );
    tokens = data.tokens ?? [];
  } catch {
    // If balance fetch fails, let the tx attempt proceed and let the RPC reject it.
    return;
  }

  const found = tokens.find((t) => {
    if (isNative) {
      // Native token: Ankr stores contract_address as the blockchain name
      return (
        t.contract_address === ankrName ||
        t.contract_ticker_symbol.toUpperCase() === ticker.toUpperCase()
      );
    }
    return t.contract_address.toLowerCase() === (tokenAddr ?? '').toLowerCase();
  });

  const heldWei   = BigInt(found?.balance ?? '0');
  const needWei   = BigInt(amountWei);

  if (heldWei < needWei) {
    const heldHuman = fromWei(heldWei.toString(), decimals);
    const needHuman = fromWei(amountWei, decimals);
    throw new Error(
      `Insufficient balance: you have ${heldHuman} ${ticker} but need ${needHuman} ${ticker}.`,
    );
  }
}

// ── Public types ───────────────────────────────────────────────────────────────

export type ExecutionStage =
  | 'idle'
  | 'building'   // fetching quote / building calldata
  | 'ready'      // tx is built — showing details, awaiting user confirmation
  | 'signing'    // waiting for Rabby approval UI
  | 'success'
  | 'error';

export interface SwapQuote {
  fromAmount: string;   // "0.2 ETH"
  toAmount:   string;   // "683.12 USDT"
  rate:       string;   // "1 ETH ≈ 3,415.6 USDT"
  gasUnits:   string;   // "~142,000 gas"
  slippage:   string;   // "1%"
}

export interface SendDetails {
  amount: string;       // "100 USDT"
  to:     string;       // "0x123…" or ENS
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useIntentExecutor(walletAddress: string) {
  const [stage,       setStage]       = useState<ExecutionStage>('idle');
  const [swapQuote,   setSwapQuote]   = useState<SwapQuote | null>(null);
  const [sendDetails, setSendDetails] = useState<SendDetails | null>(null);
  const [builtTx,     setBuiltTx]     = useState<Record<string, string> | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  const reset = useCallback(() => {
    setStage('idle');
    setSwapQuote(null);
    setSendDetails(null);
    setBuiltTx(null);
    setError(null);
  }, []);

  // ── build ─────────────────────────────────────────────────────────────────
  // Validates the intent, fetches a quote, and builds signed-ready calldata.
  // Does NOT touch the wallet or any UI page.

  const build = useCallback(async (intent: ParsedIntent) => {
    setStage('building');
    setError(null);

    try {
      // chain is always the slug (e.g. "ethereum") — rabby-api converts to chainId internally
      const chain = intent.chain ?? 'ethereum';

      // ── SWAP ──────────────────────────────────────────────────────────────
      if (intent.action === 'swap') {
        const fromTicker = (intent.fromToken ?? intent.token ?? '').toUpperCase();
        const toTicker   = (intent.toToken ?? '').toUpperCase();
        const amount     = intent.amount;

        if (!fromTicker || !toTicker || amount == null) {
          throw new Error(
            `I need: which token to sell, which to buy, and how much. ` +
            `Try: "swap 0.2 ETH for USDT"`,
          );
        }

        const fromAddr = resolveTokenAddress(chain, fromTicker);
        const toAddr   = resolveTokenAddress(chain, toTicker);
        if (!fromAddr) throw new Error(`Unknown token "${fromTicker}" on ${chain}.`);
        if (!toAddr)   throw new Error(`Unknown token "${toTicker}" on ${chain}.`);

        const fromDec   = resolveDecimals(chain, fromTicker);
        const toDec     = resolveDecimals(chain, toTicker);
        const amountWei = toWei(amount, fromDec);

        // 0. Balance check — fail fast before hitting 1inch
        await assertSufficientBalance(chain, walletAddress, fromTicker, fromAddr, amountWei, fromDec);

        // 1. Quote — for display only (pass slug, not numeric chainId)
        const quote = await apiGet<any>(
          `/v1/swap/quote?chain=${chain}` +
          `&fromToken=${fromAddr}&toToken=${toAddr}` +
          `&amount=${amountWei}&fromAddress=${walletAddress}`,
        );

        const toAmountWei   = quote.toAmount ?? quote.toTokenAmount ?? '0';
        const toAmountHuman = fromWei(String(toAmountWei), toDec);
        const toAmountNum   = Number(toAmountHuman.replace(/,/g, ''));
        const rateNum       = amount > 0 ? (toAmountNum / amount) : 0;

        setSwapQuote({
          fromAmount: `${amount} ${fromTicker}`,
          toAmount:   `${toAmountHuman} ${toTicker}`,
          rate:       `1 ${fromTicker} ≈ ${rateNum.toLocaleString('en', { maximumFractionDigits: 4 })} ${toTicker}`,
          gasUnits:   quote.estimatedGas ? `~${Number(quote.estimatedGas).toLocaleString()} gas` : 'unknown',
          slippage:   '1%',
        });

        // 2. Build — POST with JSON body (route expects application/json, not query params)
        const built = await apiPost<any>('/v1/swap/build', {
          chain,
          fromToken:   fromAddr,
          toToken:     toAddr,
          amount:      amountWei,
          fromAddress: walletAddress,
          slippage:    1,
        });

        const raw = built.tx ?? built;
        setBuiltTx({
          from:     walletAddress,
          to:       raw.to     ?? '',
          data:     raw.data   ?? '0x',
          value:    raw.value  ?? '0x0',
          ...(raw.gasPrice ? { gasPrice: String(raw.gasPrice) } : {}),
          ...(raw.gas      ? { gas:      String(raw.gas)      } : {}),
        });

        setStage('ready');
        return;
      }

      // ── SEND ──────────────────────────────────────────────────────────────
      if (intent.action === 'send') {
        const ticker = (intent.token ?? '').toUpperCase();
        const to     = intent.toAddress;
        const amount = intent.amount;

        if (!ticker || !to || amount == null) {
          throw new Error(
            `I need: which token, how much, and a recipient address. ` +
            `Try: "send 100 USDC to 0x1234…"`,
          );
        }

        const tokenAddr = resolveTokenAddress(chain, ticker);
        const isNative  = !tokenAddr || tokenAddr.toLowerCase() === NATIVE.toLowerCase();
        const decimals  = resolveDecimals(chain, ticker);
        const amountWei = toWei(amount, decimals);

        // 0. Balance check — reject before building calldata
        await assertSufficientBalance(chain, walletAddress, ticker, tokenAddr, amountWei, decimals);

        const amountHex = `0x${BigInt(amountWei).toString(16)}`;

        let tx: Record<string, string>;

        if (isNative) {
          // Plain ETH / BNB / MATIC / AVAX transfer
          tx = { from: walletAddress, to, data: '0x', value: amountHex };
        } else {
          // ERC-20: transfer(address recipient, uint256 amount)
          const sig      = '0xa9059cbb';
          const padTo    = to.replace('0x', '').padStart(64, '0');
          const padAmt   = BigInt(amountWei).toString(16).padStart(64, '0');
          tx = {
            from:  walletAddress,
            to:    tokenAddr!,
            data:  `${sig}${padTo}${padAmt}`,
            value: '0x0',
          };
        }

        setSendDetails({ amount: `${amount} ${ticker}`, to });
        setBuiltTx(tx);
        setStage('ready');
        return;
      }

      throw new Error(
        `"${intent.action}" transactions aren't yet handled by the executor. ` +
        `Supported: swap, send.`,
      );
    } catch (e: any) {
      setError(e?.message ?? 'Failed to build transaction');
      setStage('error');
    }
  }, [walletAddress]);

  // ── execute ───────────────────────────────────────────────────────────────
  // Passes the built transaction straight into Rabby's signing pipeline.
  // `wallet` = the object returned by useWallet() from @/ui/utils.

  const execute = useCallback(async (wallet: any) => {
    if (!builtTx) return;
    setStage('signing');
    setError(null);
    try {
      await wallet.sendRequest({
        method: 'eth_sendTransaction',
        params: [builtTx],
        $ctx:   { ga: { category: 'AI', source: 'ai-assistant' } },
      });
      setStage('success');
    } catch (e: any) {
      // User rejected or signing failed — treat as recoverable
      setError(e?.message ?? 'Transaction rejected');
      setStage('error');
    }
  }, [builtTx]);

  return {
    stage,
    swapQuote,
    sendDetails,
    error,
    build,
    execute,
    reset,
  };
}
