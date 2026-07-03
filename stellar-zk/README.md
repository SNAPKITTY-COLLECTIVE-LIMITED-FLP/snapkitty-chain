# STELLA Sovereign Fingerprint ZK

STELLA uses Noir for the off-chain authorship/compliance circuit and an ERRANT
sovereign contract targeting Stellar Soroban WASM for verification/storage.

Submission statement:

> STELLA lets a creator prove control of a private authorship fingerprint
> without revealing the private abjad key. Noir generates the proof. Soroban
> verifies and stores the receipt on Stellar. SnapKitty Chain mirrors the full
> WORM witness privately.

## Layout

```text
stellar-zk/
  noir/stella-fingerprint/       Noir circuit
  errant/stella-fingerprint.errant    ERRANT contract source targeting Soroban
```

## Demo Flow

1. Generate sovereign fingerprint witness.
2. Produce Noir proof off-chain.
3. Verify proof in the ERRANT contract compiled/lowered to Soroban.
4. Store verified receipt hash on Stellar.
5. Mirror full witness to SnapKitty Chain WORM ledger.
