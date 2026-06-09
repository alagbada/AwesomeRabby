/**
 * bench-full-keygen.mjs — Instrumented breakdown of P1Context.createContext()
 *
 * Times each operation inside createContext() individually so we can pinpoint
 * exactly which step is the blocker:
 *
 *   1. createPailKeyPair  (two randomPrimeStrict calls + BN key setup)
 *   2. pailPubKey.encrypt (r^n mod n² — 4096-bit modular exponentiation)
 *   3. PailProof.prove    (11 × x^M mod n — 2048-bit modular exponentiation each)
 *   4. SchnorrProof.prove (EC Schnorr, fast)
 *   5. randomBN calls     (should be negligible with patch)
 *
 * Run from AwesomeRabby/: node scripts/bench-full-keygen.mjs
 */

import { webcrypto } from 'crypto';
import { Rand }      from '@safeheron/crypto-rand';
import BN            from 'bn.js';

// ── Patches ──────────────────────────────────────────────────────────────────
Rand.config_randomBytesImp((byteSize) => {
  const bytes = new Uint8Array(byteSize);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes);
});

Rand.config_randomPrimeImp(async (byteSize) => {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: byteSize * 8 * 2,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  return new BN(Buffer.from(jwk.p, 'base64').toString('hex'), 16);
});

// ── Import library components directly ───────────────────────────────────────
const { createPailKeyPair } = await import(
  '@safeheron/crypto-paillier'
);
const { Secp256k1SchnorrProof, PailProof } = await import(
  '@safeheron/crypto-zkp'
);
const ellipticMod = await import('elliptic');
const elliptic = ellipticMod.default ?? ellipticMod;
const Secp256k1 = new elliptic.ec('secp256k1');

// ── Helpers ───────────────────────────────────────────────────────────────────
async function time(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  const bar = '█'.repeat(Math.min(Math.round(ms / 200), 40));
  console.log(`  ${label.padEnd(38)} ${String(ms.toFixed(0)).padStart(6)} ms  ${bar}`);
  return { result, ms };
}

// ── Benchmark ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  PrismTx — P1Context.createContext() step-by-step breakdown');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('  (each █ ≈ 200 ms)\n');

// Warm-up JIT
process.stdout.write('  warm-up … ');
{
  const t0 = performance.now();
  // P1Context calls createPailKeyPair(2048/8) = createPailKeyPair(256) — 256 bytes = 2048 bits
  const [pk, pub] = await createPailKeyPair(256);
  const x1 = await Rand.randomBN(32);
  await pub.encrypt(x1);
  PailProof.prove(pk, new BN(1), Secp256k1.g.mul(x1).getX(), Secp256k1.g.mul(x1).getY());
  console.log(`${(performance.now() - t0).toFixed(0)} ms (discarded)\n`);
}

// ── Timed run ────────────────────────────────────────────────────────────────
console.log('  ── Timed run ─────────────────────────────────────────────────\n');
let grandTotal = 0;

// 1. Paillier key pair (contains 2× randomPrimeStrict + BN math)
const { result: [pailPrivKey, pailPubKey], ms: t1 } =
  await time('1. createPailKeyPair(256)', () => createPailKeyPair(256));
grandTotal += t1;

// 1a. Drill into the two primes separately (re-run to see per-prime cost)
console.log();
const { ms: tp1 } = await time('   1a. randomPrimeStrict #1 (128)', () => Rand.randomPrimeStrict(128));
const { ms: tp2 } = await time('   1b. randomPrimeStrict #2 (128)', () => Rand.randomPrimeStrict(128));
console.log(`   1c. BN key-setup arithmetic (derived): ~${Math.max(0, t1 - tp1 - tp2).toFixed(0)} ms`);

// 2. EC key share x1 sampling
console.log();
const { result: x1, ms: t2 } = await time('2. Rand.randomBN(32) × 3 avg', async () => {
  const TWO = new BN(2), THREE = new BN(3);
  const min = Secp256k1.n.div(THREE), max = Secp256k1.n.mul(TWO).div(THREE);
  let x = await Rand.randomBN(32);
  while (x.lt(min) || x.gt(max)) x = await Rand.randomBN(32);
  return x;
});
grandTotal += t2;
const Q1 = Secp256k1.g.mul(x1);

// 3. Paillier encrypt(x1)  →  r^n mod n²
const { ms: t3 } = await time('3. pailPubKey.encrypt(x1)', () => pailPubKey.encrypt(x1));
grandTotal += t3;

// 4. Schnorr proof (EC only — should be fast)
const { ms: t4 } = await time('4. Secp256k1SchnorrProof.prove(x1)', () => Secp256k1SchnorrProof.prove(x1));
grandTotal += t4;

// 5. PailProof.prove  →  11 × x^M mod n  (2048-bit each)
const { ms: t5 } = await time('5. PailProof.prove (11 iterations)', () =>
  Promise.resolve(PailProof.prove(pailPrivKey, new BN(1), Q1.getX(), Q1.getY()))
);
grandTotal += t5;

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('───────────────────────────────────────────────────────────────');
console.log(`  createPailKeyPair           ${t1.toFixed(0).padStart(6)} ms`);
console.log(`    └─ of which prime gen     ${(tp1 + tp2).toFixed(0).padStart(6)} ms  (2 primes)`);
console.log(`    └─ of which BN arithmetic ~${Math.max(0, t1 - tp1 - tp2).toFixed(0).padStart(5)} ms`);
console.log(`  randomBN sampling           ${t2.toFixed(0).padStart(6)} ms`);
console.log(`  pailPubKey.encrypt(x1)      ${t3.toFixed(0).padStart(6)} ms  ← r^n mod n² (4096-bit)`);
console.log(`  Schnorr proof               ${t4.toFixed(0).padStart(6)} ms`);
console.log(`  PailProof.prove (×11)       ${t5.toFixed(0).padStart(6)} ms  ← 11× x^M mod n`);
console.log('───────────────────────────────────────────────────────────────');
console.log(`  GRAND TOTAL (approx)        ${grandTotal.toFixed(0).padStart(6)} ms`);
console.log('═══════════════════════════════════════════════════════════════\n');
