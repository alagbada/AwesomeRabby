/**
 * bench-prime-gen.mjs — Extension-side prime generation benchmark
 *
 * Tests the native WebCrypto approach used by the Rand.config_randomPrimeImp
 * patch in tssCoordinator.ts.
 *
 * Run with:  node scripts/bench-prime-gen.mjs
 *
 * What it measures:
 *   P1Context.createContext() needs two 1024-bit primes (Paillier RSA-2048).
 *   byteSize = 128  →  modulusLength = 2048  →  prime p is 1024 bits.
 */

import { webcrypto } from 'crypto';
const { subtle } = webcrypto;

const BYTE_SIZE = 128; // 1024-bit prime

function b64urlToHex(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('hex');
}

async function genPrime(label) {
  const t0 = performance.now();

  const keyPair = await subtle.generateKey(
    {
      name:           'RSASSA-PKCS1-v1_5',
      modulusLength:  BYTE_SIZE * 8 * 2,   // 2048-bit RSA → two 1024-bit primes
      publicExponent: new Uint8Array([1, 0, 1]),
      hash:           'SHA-256',
    },
    true,              // extractable
    ['sign', 'verify'],
  );

  const jwk = await subtle.exportKey('jwk', keyPair.privateKey);
  const elapsed = performance.now() - t0;

  const pHex   = b64urlToHex(jwk.p);
  const pBytes = Buffer.from(pHex, 'hex');
  const highBitSet = (pBytes[0] >> 7) === 1;

  console.log(`  ${label}`);
  console.log(`    Time      : ${elapsed.toFixed(1)} ms`);
  console.log(`    Prime len : ${pBytes.length} bytes  (${pBytes.length * 8} bits)`);
  console.log(`    High bit  : ${highBitSet ? 'SET ✓' : 'NOT SET — retry would be needed ✗'}`);
  console.log(`    p (hex)   : ${pHex.slice(0, 16)}…${pHex.slice(-8)}`);
  console.log();

  return elapsed;
}

console.log('═══════════════════════════════════════════════════════');
console.log('  PrismTx  —  Extension prime generation benchmark');
console.log(`  byteSize = ${BYTE_SIZE}  (${BYTE_SIZE * 8}-bit prime, 2048-bit RSA modulus)`);
console.log('═══════════════════════════════════════════════════════\n');

// Warm up V8 JIT
await genPrime('warm-up (discarded)');

// Actual benchmark — P1Context.createContext() calls randomPrimeStrict TWICE
// (Paillier needs two independent primes p and q)
console.log('── Timed runs (Paillier needs 2 primes) ──────────────\n');
const t1 = await genPrime('prime 1');
const t2 = await genPrime('prime 2');

console.log('═══════════════════════════════════════════════════════');
console.log(`  Total for 2 primes : ${(t1 + t2).toFixed(1)} ms`);
console.log(`  Expected old (JS)  : ~30 000 – 120 000 ms`);
console.log(`  Speedup            : ~${Math.round((60_000) / ((t1 + t2) / 2))}×`);
console.log('═══════════════════════════════════════════════════════');
