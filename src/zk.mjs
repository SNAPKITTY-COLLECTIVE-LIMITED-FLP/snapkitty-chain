// zk.mjs — STELLA Sovereign Fingerprint proof envelope
//
// Protocol target: Noir proof generated off-chain and verified in a Stellar
// Soroban Rust contract. This devnet module keeps certificate shape stable
// before the final Noir proving key/verifier artifact is generated.

import { sha256, stableStringify } from "./witness.mjs";

export const ZK_PROTOCOL = "noir-ultrahonk";
export const ZK_CIRCUIT_ID = "stella_sovereign_fingerprint_v1";
export const SOVEREIGN_CONTRACT = "stellar-zk/errant/stella-fingerprint.errant";
export const SOROBAN_TARGET = "soroban-wasm";

export function sovereignFingerprintPublic(privateFingerprintCommitment) {
  return sha256(`STELLA:FINGERPRINT:${privateFingerprintCommitment}`);
}

export function createZkProofEnvelope(witness, options = {}) {
  const privateFingerprintCommitment = options.privateFingerprintCommitment || sha256("demo-private-abjad-key");
  const publicFingerprint = options.publicFingerprint || sovereignFingerprintPublic(privateFingerprintCommitment);
  const publicSignals = {
    public_fingerprint: publicFingerprint,
    snapaddr_hash: sha256(witness.snapaddr),
    worm_hash: witness.worm_hash,
    verdict_hash: sha256(witness.verdict),
    action_hash: sha256(witness.action),
  };

  const proof = {
    protocol: ZK_PROTOCOL,
    circuit_id: ZK_CIRCUIT_ID,
    proving_system: "Noir/UltraHonk",
    status: "devnet-proof-envelope",
    statement: "prove control of a private authorship fingerprint without revealing the private abjad key",
    proof_commitment: sha256({
      circuit_id: ZK_CIRCUIT_ID,
      publicSignals,
      witness_seal: witness.seal,
    }),
    public_signals: publicSignals,
    soroban_verifier: {
      contract_path: SOVEREIGN_CONTRACT,
      source_language: "ERRANT",
      target: SOROBAN_TARGET,
      verifier_family: "snapkitty-errant-to-soroban-ultrahonk-adapter",
      verify_method: "verify_fingerprint",
      stores_receipt: true,
    },
  };

  proof.envelope_hash = sha256(stableStringify(proof));
  return proof;
}

export function verifyZkProofEnvelope(witness, proof) {
  if (!proof || proof.protocol !== ZK_PROTOCOL || proof.circuit_id !== ZK_CIRCUIT_ID) {
    return { ok: false, reason: "bad_zk_protocol" };
  }
  const expectedFields = {
    snapaddr_hash: sha256(witness.snapaddr),
    worm_hash: witness.worm_hash,
    verdict_hash: sha256(witness.verdict),
    action_hash: sha256(witness.action),
  };
  for (const [field, expected] of Object.entries(expectedFields)) {
    if (proof.public_signals?.[field] !== expected) {
      return { ok: false, reason: `bad_public_signal:${field}` };
    }
  }
  const expectedCommitment = sha256({
    circuit_id: ZK_CIRCUIT_ID,
    publicSignals: proof.public_signals,
    witness_seal: witness.seal,
  });
  if (proof.proof_commitment !== expectedCommitment) {
    return { ok: false, reason: "bad_proof_commitment" };
  }
  return { ok: true, reason: "noir_soroban_envelope_verified" };
}
