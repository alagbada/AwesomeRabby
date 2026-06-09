/**
 * AwesomeApiService
 *
 * Thin client for the self-hosted `rabby-api` backend.
 * Exposes the same method signatures as `OpenApiService` for the endpoints we
 * support so call-site changes in wallet.ts are surgical and type-safe.
 *
 * Endpoints covered:
 *   getTotalBalance  →  GET /v1/balance/:chain/:address  (Covalent GoldRush)
 *   gasMarketV2      →  GET /v1/gas/:chain               (public RPC)
 *
 * Everything else (tx simulation, security checks, DeFi protocols, copy-trade…)
 * continues to fall through to the original openapiService / api.rabby.io.
 */

import type {
  TotalBalanceResponse,
  ChainWithBalance,
  GasLevel,
} from '@rabby-wallet/rabby-api/dist/types';
import { AWESOME_API_URL } from '@/constant';

// ─── Chain metadata ───────────────────────────────────────────────────────────
//
// Maps DeBank server chain IDs (used throughout the wallet) to:
//   • slug       — our API's chain name
//   • communityId — EVM chain ID
//   • name, symbol, nativeTokenId, wrappedTokenId
//
// DeBank serverId values confirmed from @debank/common chain-data.

interface ChainMeta {
  slug: string;
  communityId: number;
  name: string;
  symbol: string;
  nativeTokenId: string;
  wrappedTokenId: string;
  logoUrl: string;
}

const CHAIN_META: Record<string, ChainMeta> = {
  eth: {
    slug: 'ethereum',
    communityId: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    nativeTokenId: 'eth',
    wrappedTokenId: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/eth/eth.png',
  },
  bsc: {
    slug: 'bsc',
    communityId: 56,
    name: 'BNB Chain',
    symbol: 'BNB',
    nativeTokenId: 'bsc',
    wrappedTokenId: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/bsc/bsc.png',
  },
  matic: {
    slug: 'polygon',
    communityId: 137,
    name: 'Polygon',
    symbol: 'MATIC',
    nativeTokenId: 'matic',
    wrappedTokenId: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/matic/matic.png',
  },
  arb: {
    slug: 'arbitrum',
    communityId: 42161,
    name: 'Arbitrum',
    symbol: 'ETH',
    nativeTokenId: 'arb',
    wrappedTokenId: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/arb/arb.png',
  },
  op: {
    slug: 'optimism',
    communityId: 10,
    name: 'Optimism',
    symbol: 'ETH',
    nativeTokenId: 'op',
    wrappedTokenId: '0x4200000000000000000000000000000000000006',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/op/op.png',
  },
  avax: {
    slug: 'avalanche',
    communityId: 43114,
    name: 'Avalanche',
    symbol: 'AVAX',
    nativeTokenId: 'avax',
    wrappedTokenId: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/avax/avax.png',
  },
  base: {
    slug: 'base',
    communityId: 8453,
    name: 'Base',
    symbol: 'ETH',
    nativeTokenId: 'base',
    wrappedTokenId: '0x4200000000000000000000000000000000000006',
    logoUrl: 'https://static.debank.com/image/chain/logo_url/base/base.png',
  },
};

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  // AWESOME_API_URL can be overridden at runtime from chrome.storage.local —
  // read it fresh on each call so settings changes take effect immediately.
  let baseUrl = AWESOME_API_URL;
  try {
    const stored = await new Promise<Record<string, string>>((resolve) =>
      chrome.storage.local.get(['awesome_api_url'], resolve),
    );
    if (stored.awesome_api_url) baseUrl = stored.awesome_api_url;
  } catch {
    // not in extension context (unit tests etc.)
  }

  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`AwesomeApi ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

// ─── API response shapes ──────────────────────────────────────────────────────

interface BalanceToken {
  contract_address: string;
  contract_name: string;
  contract_ticker_symbol: string;
  contract_decimals: number;
  balance: string;
  quote: number;          // USD value of this holding
  quote_rate: number;     // USD price per token
  logo_url: string;
  type: string;
}

interface BalanceApiResponse {
  ok: boolean;
  tokens: BalanceToken[];
}

// /v1/balance/all/:address — multi-chain in one Ankr call
interface AllBalanceApiResponse {
  ok: boolean;
  address: string;
  byChain: Record<string, BalanceToken[]>;   // key = our chain slug
}

interface GasApiResponse {
  ok: boolean;
  chain: string;
  gasPriceGwei: number;
  baseFeeGwei: number | null;
  maxPriorityFeeGwei: number | null;
}

// /v1/onramp/config
export interface OnRampConfig {
  ok: boolean;
  ourFeePercent: number;
  ivorypayFeePercent: number;
  totalFeePercent: number;
  supportedCryptos: string[];
  supportedNetworks: string[];
  minAmountNgn: number;
}

// /v1/onramp/ngn/initiate response
export interface OnRampInitiateResponse {
  ok: boolean;
  reference: string;
  // What the user pays
  amountNgn: number;
  // Fee breakdown
  ourFeeNgn: number;
  ourFeePercent: number;
  ivorypayFeePercent: number;
  // Bank account to transfer to
  accountNumber: string;
  bankName: string;
  accountName: string;
  expiresIn: number;       // seconds
  // What lands in the wallet
  crypto: string;
  network: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class AwesomeApiService {
  // ── getTotalBalance ─────────────────────────────────────────────────────────
  //
  // Fetches token balances across all supported chains in a SINGLE Ankr call
  // (via /v1/balance/all/:address) and returns the same shape as
  // OpenApiService.getTotalBalance.
  //
  // DeFi protocol positions (Aave, Uniswap LP…) still come from api.rabby.io
  // via getAppChainList — this only replaces the raw token balance fetch.

  async getTotalBalance(address: string): Promise<TotalBalanceResponse> {
    const addr = address.toLowerCase();

    // Single multi-chain Ankr call — far more efficient than 7 parallel requests
    const data = await getJson<AllBalanceApiResponse>(`/v1/balance/all/${addr}`);

    // Build a reverse map: slug → DeBank serverId
    const serverIdBySlug: Record<string, string> = {};
    for (const [serverId, meta] of Object.entries(CHAIN_META)) {
      serverIdBySlug[meta.slug] = serverId;
    }

    let totalUsdValue = 0;
    const chainList: ChainWithBalance[] = [];

    for (const [slug, tokens] of Object.entries(data.byChain)) {
      const serverId = serverIdBySlug[slug];
      if (!serverId) continue; // chain returned by API but not in our supported set
      const meta = CHAIN_META[serverId];

      // Sum USD value across all non-NFT tokens on this chain
      const chainUsd = tokens
        .filter((t) => t.type !== 'nft')
        .reduce((sum, t) => sum + (t.quote ?? 0), 0);

      if (chainUsd === 0) continue; // skip chains with no holdings

      totalUsdValue += chainUsd;
      chainList.push({
        id: serverId,
        community_id: meta.communityId,
        name: meta.name,
        native_token_id: meta.nativeTokenId,
        logo_url: meta.logoUrl,
        wrapped_token_id: meta.wrappedTokenId,
        symbol: meta.symbol,
        is_support_history: true,
        born_at: null,
        usd_value: chainUsd,
      });
    }

    // Sort chains by USD value descending (matches DeBank ordering)
    chainList.sort((a, b) => b.usd_value - a.usd_value);

    return { total_usd_value: totalUsdValue, chain_list: chainList };
  }

  // ── gasMarketV2 ─────────────────────────────────────────────────────────────
  //
  // Same signature as OpenApiService.gasMarketV2.
  // Prices are returned in **wei** (DeBank convention).
  // Builds slow / normal / fast tiers from base fee + priority fee.

  async gasMarketV2(options: {
    chainId: string;
    customGas?: number;
    tx?: {
      from: string;
      to: string;
      data?: string;
      value?: string;
      nonce: string;
      gasPrice?: string;
    };
  }): Promise<GasLevel[]> {
    const meta = CHAIN_META[options.chainId];
    if (!meta) {
      // Unknown chain — throw so wallet.ts falls back to openapiService
      throw new Error(`AwesomeApi: unsupported chainId "${options.chainId}"`);
    }

    const data = await getJson<GasApiResponse>(`/v1/gas/${meta.slug}`);

    const toWei = (gwei: number): number => Math.round(gwei * 1e9);

    // baseFeeWei: prefer EIP-1559 base fee; fall back to legacy gas price
    const baseFeeWei = data.baseFeeGwei != null
      ? toWei(data.baseFeeGwei)
      : toWei(data.gasPriceGwei);

    // priorityWei: miner tip (EIP-1559) or 10% of base as a heuristic
    const priorityWei = data.maxPriorityFeeGwei != null
      ? toWei(data.maxPriorityFeeGwei)
      : Math.round(baseFeeWei * 0.1);

    const levels: GasLevel[] = [
      {
        level: 'slow',
        price: Math.round(baseFeeWei * 0.9) + priorityWei,
        front_tx_count: 20,
        estimated_seconds: 60,
        priority_price: priorityWei,
        base_fee: baseFeeWei,
      },
      {
        level: 'normal',
        price: baseFeeWei + priorityWei,
        front_tx_count: 5,
        estimated_seconds: 15,
        priority_price: priorityWei,
        base_fee: baseFeeWei,
      },
      {
        level: 'fast',
        price: Math.round(baseFeeWei * 1.25) + priorityWei * 2,
        front_tx_count: 0,
        estimated_seconds: 5,
        priority_price: priorityWei * 2,
        base_fee: baseFeeWei,
      },
    ];

    if (options.customGas != null) {
      levels.push({
        level: 'custom',
        price: options.customGas,
        front_tx_count: 0,
        estimated_seconds: 0,
        priority_price: null,
        base_fee: baseFeeWei,
      });
    }

    return levels;
  }

  // ── getNgnOnRampConfig ──────────────────────────────────────────────────────
  //
  // Fetches the current fee percentages and supported options from rabby-api.
  // Call this once when the on-ramp UI opens to display accurate fee info.

  async getNgnOnRampConfig(): Promise<OnRampConfig> {
    return getJson<OnRampConfig>('/v1/onramp/config');
  }

  // ── initiateNgnOnRamp ───────────────────────────────────────────────────────
  //
  // Creates an Ivorypay virtual bank account for the user to transfer NGN into.
  // Returns the bank details + full fee breakdown to display in the UI.
  //
  // The user then does a regular bank transfer (from their banking app) to the
  // returned accountNumber / bankName. Ivorypay fires a webhook to rabby-api
  // on confirmation, which triggers the USDT payout to walletAddress.

  async initiateNgnOnRamp(opts: {
    amountNgn: number;
    walletAddress: string;
    crypto?: string;       // default 'USDT'
    network?: string;      // default 'ethereum'
    email?: string;
  }): Promise<OnRampInitiateResponse> {
    return getJson<OnRampInitiateResponse>(
      `/v1/onramp/ngn/initiate`,
      {
        method: 'POST',
        body: JSON.stringify(opts),
      },
    );
  }
}

export const awesomeApiService = new AwesomeApiService();
export default awesomeApiService;
