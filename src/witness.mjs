// witness.mjs — UnifiedWitness · snapaddr · WORM seal
//
// Every STELLA workflow produces exactly one UnifiedWitness.
// The witness is the atomic proof unit: agent execution → WORM seal → snapaddr.
//
// snapaddr format: snapaddr:<sha256hex>
// seal format:     sha256(stableStringify(witness))
//
// SnapKitty Collective · STELLA · 2026

import { createHash, randomBytes } from "node:crypto";

// ── Primitives ──────────────────────────────────────────────────────────────

export function sha256(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
  return out;
}

function randomId() {
  return randomBytes(8).toString("hex");
}

// ── snapaddr — canonical content address ────────────────────────────────────
// Deterministic: same (action, verdict, worm_hash, sealed_at) → same snapaddr.
// Independent of witness.id or session_id.

export function snapaddr(witness) {
  const canonical = stableStringify({
    action:    witness.action,
    sealed_at: witness.sealed_at,
    verdict:   witness.verdict,
    worm_hash: witness.worm_hash,
  });
  return `snapaddr:${sha256(canonical)}`;
}

// ── UnifiedWitness factory ──────────────────────────────────────────────────

export function createWitness(action, stages, sessionId) {
  const sealStage = stages.find((s) => s.stage === "SEAL");
  const gateStage = stages.find((s) => s.stage === "TRUST-DEED-GATE");
  const bobStage  = stages.find((s) => s.stage === "BOB");
  const verdict   = gateStage?.ok !== false ? "EVIDENCE" : "SILENCE";
  const wormHash  = sealStage?.worm_hash || sha256(`${action}:${Date.now()}`);

  const witness = {
    id:         `wit_${randomId()}`,
    session_id: sessionId,
    action,
    verdict,
    agent:      bobStage?.agent || "STELLA",
    stages,
    worm_hash:  wormHash,
    sealed_at:  new Date().toISOString(),
  };

  witness.snapaddr = snapaddr(witness);
  witness.seal     = sha256(stableStringify(witness));
  return witness;
}
