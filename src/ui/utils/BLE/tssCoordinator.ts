/**
 * PrismTx TSS Coordinator
 *
 * Orchestrates the @safeheron/two-party-ecdsa-js protocol rounds between:
 *   P1 — this extension (runs here, in the approval popup)
 *   P2 — PrismTx Key mobile app (runs on the phone, communicates via BLE)
 *
 * Two operations are supported:
 *
 *   1. Key Generation (DKG) — run once during device pairing
 *      3 BLE messages, produces KeyShare1 (stored in vault) and a
 *      wallet address.
 *
 *   2. Signing — run for every transaction / message approval
 *      4 BLE messages, produces a standard ECDSA signature {r, s, v}.
 *
 * The coordinator does NOT touch the BLE connection directly — it delegates
 * all send/receive to the BLEService it receives as an argument. This keeps
 * the TSS protocol logic decoupled from the transport layer.
 */

import BN from 'bn.js';
import { Rand } from '@safeheron/crypto-rand';
import { TPCEcdsaKeyGen, TPCEcdsaSign } from '@safeheron/two-party-ecdsa-js';
import {
  publicToAddress,
  toChecksumAddress,
  addHexPrefix,
  bytesToHex,
} from '@ethereumjs/util';
import { BLEService } from './bleService';
import { BLEMessageType } from './gattProfile';

// ─── Speed up Paillier key generation ────────────────────────────────────────
//
// P1Context.createContext() generates a 2048-bit Paillier key pair which needs
// two 1024-bit primes. @safeheron/crypto-rand defaults to a pure-JS Miller-Rabin
// loop that takes 30–120 s even on Chrome's V8.
//
// Replace it with native WebCrypto RSA key generation: the browser calls into
// OS-level OpenSSL/BoringSSL and returns in milliseconds. We extract prime `p`
// from the JWK and hand it back as a BN.
//
// This runs at module-load time so it is guaranteed to be in effect before any
// call to P1Context.createContext() (which only happens on a user gesture).
Rand.config_randomPrimeImp(async (byteSize: number) => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: byteSize * 8 * 2, // two primes of byteSize*8 bits each
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true, // extractable — required for exportKey('jwk')
    ['sign', 'verify']
  );
  const jwk = (await crypto.subtle.exportKey(
    'jwk',
    keyPair.privateKey
  )) as JsonWebKey;
  // jwk.p is base64url — normalise to standard base64 for atob, then convert to hex
  const b64 = jwk.p!.replace(/-/g, '+').replace(/_/g, '/');
  const hex = Array.from(atob(b64), (c) =>
    c.charCodeAt(0).toString(16).padStart(2, '0')
  ).join('');
  return new BN(hex, 16);
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeyGenResult {
  /** JSON-serialised KeyShare1 — store in the encrypted vault */
  keyShare1Json: string;
  /** Uncompressed public key as hex (65 bytes, '04' prefix) */
  publicKeyHex: string;
  /** Ethereum address (checksummed) derived from the joint public key */
  address: string;
}

export interface SignResult {
  /** ECDSA r component as hex */
  r: string;
  /** ECDSA s component as hex */
  s: string;
  /** Recovery parameter (27 or 28) */
  v: number;
  /** Full serialised signature as hex (r + s + v) ready for eth_sendRawTransaction */
  signatureHex: string;
}

// ─── Timeouts ────────────────────────────────────────────────────────────────
// DKG involves heavy elliptic-curve math on the phone — give it plenty of room.
const DKG_ROUND_TIMEOUT_MS = 5 * 60_000; // 5 minutes per round
// Signing is faster (no key generation), but still needs a generous timeout.
const SIGN_ROUND_TIMEOUT_MS = 2 * 60_000; // 2 minutes per round

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Run the P1 side of the Lindell17 DKG protocol over BLE.
 *
 * Round flow:
 *   P1.step1() → msg1 → Phone (via COMM_WRITE)
 *   Phone (P2.step1) → msg2 → P1 (via COMM_NOTIFY)
 *   P1.step2(msg2) → msg3 → Phone (via COMM_WRITE)
 *   Phone (P2.step2) completes, exports KeyShare2
 *   P1 exports KeyShare1
 *
 * @param ble        Connected BLEService instance
 * @param sessionId  Unique ID for this DKG session (generated in pairing UI)
 */
export async function runKeyGenP1(
  ble: BLEService,
  sessionId: string
): Promise<KeyGenResult> {
  const sid = sessionId.slice(0, 8); // short prefix for log readability

  // Initialise P1 context (Paillier key gen — the slow part)
  console.log(`[P1 DKG ${sid}] createContext — start`);
  const t0 = Date.now();
  const p1 = await TPCEcdsaKeyGen.P1Context.createContext();
  console.log(`[P1 DKG ${sid}] createContext — done (${Date.now() - t0} ms)`);

  // ── Round 1: P1 → Phone ──────────────────────────────────────────────────
  const msg1Bytes = p1.step1();
  console.log(
    `[P1 DKG ${sid}] → KEYGEN_R1 (${msg1Bytes.length} bytes) sending…`
  );
  await ble.send({
    type: BLEMessageType.KEYGEN_R1,
    sessionId,
    data: toBase64(msg1Bytes),
  });
  console.log(
    `[P1 DKG ${sid}] → KEYGEN_R1 sent. Waiting for R2… (timeout ${
      DKG_ROUND_TIMEOUT_MS / 1000
    }s)`
  );

  // ── Round 2: Phone → P1 ──────────────────────────────────────────────────
  const response1 = await ble.receive(DKG_ROUND_TIMEOUT_MS);
  console.log(
    `[P1 DKG ${sid}] ← received type="${
      response1.type
    }" sessionId="${response1.sessionId?.slice(0, 8)}"`
  );
  assertMessageType(
    response1.type,
    BLEMessageType.KEYGEN_R2,
    sessionId,
    response1.sessionId
  );
  const msg2Bytes = fromBase64(response1.data);
  console.log(
    `[P1 DKG ${sid}] ← KEYGEN_R2 OK (${msg2Bytes.length} bytes). Running step2…`
  );

  // ── Round 3: P1 → Phone ──────────────────────────────────────────────────
  const msg3Bytes = p1.step2(msg2Bytes);
  console.log(
    `[P1 DKG ${sid}] → KEYGEN_R3 (${msg3Bytes.length} bytes) sending…`
  );
  await ble.send({
    type: BLEMessageType.KEYGEN_R3,
    sessionId,
    data: toBase64(msg3Bytes),
  });
  console.log(`[P1 DKG ${sid}] → KEYGEN_R3 sent. Waiting for KEYGEN_DONE…`);

  // ── Wait for phone to confirm DKG complete ────────────────────────────────
  const response2 = await ble.receive(DKG_ROUND_TIMEOUT_MS);
  console.log(`[P1 DKG ${sid}] ← received type="${response2.type}"`);
  assertMessageType(
    response2.type,
    BLEMessageType.KEYGEN_DONE,
    sessionId,
    response2.sessionId
  );
  console.log(`[P1 DKG ${sid}] ← KEYGEN_DONE received. Exporting key share…`);

  // ── Export key share ─────────────────────────────────────────────────────
  const keyShare1 = p1.exportKeyShare();
  const keyShare1Json = JSON.stringify(keyShare1);
  const address = deriveAddress(keyShare1);
  const publicKeyHex = derivePublicKeyHex(keyShare1);
  console.log(`[P1 DKG ${sid}] ✓ complete — address: ${address}`);

  return { keyShare1Json, publicKeyHex, address };
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Run the P1 side of the Lindell17 two-party signing protocol over BLE.
 *
 * Round flow:
 *   P1.step1() → msg1 → Phone (via COMM_WRITE)
 *   Phone (P2.step1) → msg2 → P1 (via COMM_NOTIFY)
 *   P1.step2(msg2) → msg3 → Phone (via COMM_WRITE)
 *   Phone (P2.step2) → msg4 → P1 (via COMM_NOTIFY)
 *   P1.step3(msg4) → done
 *   P1.exportSig() → { r, s, v }
 *
 * @param ble           Connected BLEService instance
 * @param keyShare1Json JSON-serialised KeyShare1 from vault
 * @param msgHashHex    32-byte keccak256 hash of the transaction/message (hex, with 0x prefix)
 * @param sessionId     Unique ID for this signing session
 */
export async function runSignP1(
  ble: BLEService,
  keyShare1Json: string,
  msgHashHex: string,
  sessionId: string
): Promise<SignResult> {
  const sid = sessionId.slice(0, 8);
  console.log(`[P1 SIGN ${sid}] createContext — start`);
  const msgHashBN = new BN(msgHashHex.replace(/^0x/, ''), 16);
  const p1 = await TPCEcdsaSign.P1Context.createContext(
    keyShare1Json,
    msgHashBN
  );
  console.log(`[P1 SIGN ${sid}] createContext — done`);

  // ── Round 1: P1 → Phone ──────────────────────────────────────────────────
  const msg1Bytes = p1.step1();
  console.log(
    `[P1 SIGN ${sid}] → SIGN_R1 (${msg1Bytes.length} bytes) sending…`
  );
  await ble.send({
    type: BLEMessageType.SIGN_R1,
    sessionId,
    data: toBase64(msg1Bytes),
  });
  console.log(`[P1 SIGN ${sid}] → SIGN_R1 sent. Waiting for R2…`);

  // ── Round 2: Phone → P1 ──────────────────────────────────────────────────
  const response1 = await ble.receive(SIGN_ROUND_TIMEOUT_MS);
  console.log(`[P1 SIGN ${sid}] ← received type="${response1.type}"`);
  assertMessageType(
    response1.type,
    BLEMessageType.SIGN_R2,
    sessionId,
    response1.sessionId
  );
  const msg2Bytes = fromBase64(response1.data);
  console.log(
    `[P1 SIGN ${sid}] ← SIGN_R2 OK (${msg2Bytes.length} bytes). Running step2…`
  );

  // ── Round 3: P1 → Phone ──────────────────────────────────────────────────
  const msg3Bytes = p1.step2(msg2Bytes);
  console.log(
    `[P1 SIGN ${sid}] → SIGN_R3 (${msg3Bytes.length} bytes) sending…`
  );
  await ble.send({
    type: BLEMessageType.SIGN_R3,
    sessionId,
    data: toBase64(msg3Bytes),
  });
  console.log(`[P1 SIGN ${sid}] → SIGN_R3 sent. Waiting for R4…`);

  // ── Round 4: Phone → P1 ──────────────────────────────────────────────────
  const response2 = await ble.receive(SIGN_ROUND_TIMEOUT_MS);
  assertMessageType(
    response2.type,
    BLEMessageType.SIGN_R4,
    sessionId,
    response2.sessionId
  );
  const msg4Bytes = fromBase64(response2.data);

  // ── Final step: assemble signature ───────────────────────────────────────
  console.log(
    `[P1 SIGN] ← SIGN_R4 OK (${msg4Bytes.length} bytes). Running step3…`
  );
  p1.step3(msg4Bytes);
  const [r, s, v] = p1.exportSig() as [BN, BN, number];
  console.log(`[P1 SIGN] ✓ signature assembled (v=${v < 27 ? v + 27 : v})`);

  const rHex = r.toString(16).padStart(64, '0');
  const sHex = s.toString(16).padStart(64, '0');
  // Ethereum uses 27/28 for v; the library returns 0/1
  const vNormalised = v < 27 ? v + 27 : v;
  const vHex = vNormalised.toString(16).padStart(2, '0');

  return {
    r: addHexPrefix(rHex),
    s: addHexPrefix(sHex),
    v: vNormalised,
    signatureHex: addHexPrefix(rHex + sHex + vHex),
  };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Validates that an incoming message is the expected type and belongs to
 * the current session — guards against stale or mismatched messages.
 */
function assertMessageType(
  actual: BLEMessageType,
  expected: BLEMessageType,
  expectedSessionId: string,
  actualSessionId: string
): void {
  if (actual !== expected) {
    throw new Error(
      `TSS: expected message type "${expected}" but received "${actual}"`
    );
  }
  if (actualSessionId !== expectedSessionId) {
    throw new Error(
      'TSS: session ID mismatch — ' +
        `expected "${expectedSessionId}" but received "${actualSessionId}". ` +
        'This may be a stale message from a previous session.'
    );
  }
}

/**
 * Derives the Ethereum wallet address from a KeyShare1 object.
 *
 * The joint public key Q is a secp256k1 curve point stored on the key share.
 * publicToAddress() from @ethereumjs/util takes the 64-byte uncompressed
 * key (without the 0x04 prefix) and returns the 20-byte address.
 */
function deriveAddress(keyShare1: any): string {
  const pubKeyBytes = getPublicKeyBytes(keyShare1);
  // publicToAddress expects the 64-byte raw key (x||y), without 04 prefix
  const addressBuffer = publicToAddress(pubKeyBytes.slice(1), true);
  return toChecksumAddress(addHexPrefix(bytesToHex(addressBuffer)));
}

/**
 * Returns the uncompressed public key as a hex string (04 || x || y).
 */
function derivePublicKeyHex(keyShare1: any): string {
  const pubKeyBytes = getPublicKeyBytes(keyShare1);
  return bytesToHex(pubKeyBytes);
}

/**
 * Extracts the 65-byte uncompressed public key from the KeyShare1 object.
 *
 * The joint public key Q is a curve point from the `elliptic` library.
 * `encode('array')` returns [0x04, ...x_bytes, ...y_bytes] (65 bytes).
 */
function getPublicKeyBytes(keyShare1: any): Uint8Array {
  // The Q property holds the joint public key as an EC point
  const Q = keyShare1?.Q;
  if (!Q || typeof Q.encode !== 'function') {
    throw new Error(
      'TSS: could not extract joint public key from KeyShare1. ' +
        'The key share may be malformed.'
    );
  }
  return new Uint8Array(Q.encode('array', false)); // false = uncompressed
}
