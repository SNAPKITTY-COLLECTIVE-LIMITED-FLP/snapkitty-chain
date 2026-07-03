# ERRANT Contract Source

`stella-fingerprint.errant` is the source of truth for the STELLA on-chain
verifier contract.

The contract targets Stellar Soroban WASM, but the source language is ERRANT so
the proof rule stays inside the SnapKitty DSL stack instead of being authored
directly as generic Rust application code.

Contract statement:

```text
prove control of a private authorship fingerprint without revealing the private abjad key
```

Lowering target:

```text
ERRANT -> Soroban WASM -> Stellar testnet
```

The current JavaScript devnet uses a deterministic proof envelope. The ERRANT
contract defines the production verifier boundary for the Noir/UltraHonk proof.
