// anchor.mjs — Settlement anchoring: SnapKitty Chain + Stellar
//
// Stage 1: Anchor witness to SnapKitty Chain (local WORM ledger)
// Stage 2: Stellar anchor via memo hash / testnet transaction reference
//
// In production: submit a real Stellar testnet transaction with memo hash.
// For hackathon demo: deterministic testnet tx hash derived from snapaddr.
//
// SnapKitty Collective · STELLA · 2026

import { sha256, stableStringify } from "./witness.mjs";
import { createZkProofEnvelope } from "./zk.mjs";

// ── Stellar anchor ──────────────────────────────────────────────────────────
// Memo hash = first 32 bytes of sha256(STELLA | snapaddr | worm_hash)
// In production this is submitted through Horizon testnet as a payment/no-op
// transaction carrying the memo hash.

export function stellarAnchor(witness) {
  const zkProof = createZkProofEnvelope(witness);
  const memoHash = sha256(
    `STELLA:${witness.snapaddr}:${witness.worm_hash}:${zkProof.envelope_hash}`
  );
  const txHash = sha256(`STELLAR-TESTNET:${memoHash}`);
  return {
    network:      "stellar-testnet",
    horizon:      "https://horizon-testnet.stellar.org",
    memo_type:    "MEMO_HASH",
    memo_hash:    memoHash.slice(0, 64),
    tx_hash:      txHash,
    zk_envelope_hash: zkProof.envelope_hash,
    soroban_verifier: zkProof.soroban_verifier,
    anchored_at:  new Date().toISOString(),
    explorer:     `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    note:         "deterministic Stellar testnet anchor · snapaddr SHA-256 committed",
  };
}

// ── Settlement Certificate ──────────────────────────────────────────────────

export function settlementCertificate(witness, chainAnchor, stellarAnchor) {
  const zkProof = createZkProofEnvelope(witness);
  const cert = {
    certificate_id: `cert_${witness.id.slice(4)}`,
    witness_id:     witness.id,
    snapaddr:       witness.snapaddr,
    verdict:        witness.verdict,
    agent:          witness.agent,
    worm_hash:      witness.worm_hash,
    zk_proof:       zkProof,
    chain_anchor:   chainAnchor,
    stellar_anchor: stellarAnchor,
    issued_at:      new Date().toISOString(),
  };
  cert.seal = sha256(stableStringify(cert));
  return cert;
}
