import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockHash,
  fromHexOrDecimal,
  sha256,
  stableStringify,
  txHash,
  verifyTransactionSignature
} from "./crypto.mjs";
import { consensusRoot, createConsensusProof, verifyConsensusProof } from "./consensus.mjs";

const FRG = 1_000_000_000_000_000_000n;

export const DEFAULT_CHAIN_ID = 0x534b;
export const DEFAULT_DIFFICULTY = 2;
export const DEFAULT_BLOCK_REWARD = 5n * FRG;
export const DEFAULT_GAS_LIMIT = 21_000n;
export const DEFAULT_GAS_PRICE = 1_000_000_000n;

export class SnapKittyChain {
  constructor(options = {}) {
    this.chainId = options.chainId || DEFAULT_CHAIN_ID;
    this.difficulty = options.difficulty || DEFAULT_DIFFICULTY;
    this.blockReward = fromHexOrDecimal(options.blockReward, DEFAULT_BLOCK_REWARD);
    this.dataDir = options.dataDir;
    this.blocks = [];
    this.blockIndex = new Map();
    this.worm = [];
    this.witnesses = new Map();
    this.state = createEmptyState();

    if (this.dataDir && this.load()) return;
    this.createGenesis(options.genesisProducer || "GENESIS");
  }

  createGenesis(producer) {
    const genesis = {
      version: 1,
      chainId: this.chainId,
      height: 0,
      prevHash: "0".repeat(64),
      timestamp: 1710000000000,
      producer,
      transactions: [],
      txRoot: merkleRoot([]),
      stateRoot: this.stateRoot(),
      gasUsed: "0",
      baseFee: DEFAULT_GAS_PRICE.toString(),
      consensusRoot: sha256("GENESIS_CONSENSUS"),
      difficulty: 0,
      cumulativeWork: 0,
      nonce: 0
    };
    genesis.hash = blockHash(genesis);
    genesis.seal = this.seal("GENESIS", genesis.hash, genesis);
    this.blocks = [genesis];
    this.blockIndex.set(genesis.hash, genesis);
    this.persist();
  }

  head() {
    return this.blocks[this.blocks.length - 1];
  }

  height() {
    return this.head().height;
  }

  getBalance(address) {
    return this.state.balances.get(address) || 0n;
  }

  getNonce(address) {
    return this.state.nonces.get(address) || 0;
  }

  faucet(address, amount, reason = "devnet_faucet") {
    const value = fromHexOrDecimal(amount);
    this.credit(address, value);
    const event = { address, amount: value.toString(), reason, timestamp: Date.now() };
    const seal = this.seal("FAUCET", address, event);
    this.persist();
    return { address, amount: value.toString(), seal };
  }

  buildCandidate(producer, mempoolTxs = [], limit = 200) {
    const tempState = cloneState(this.state);
    const accepted = [];
    const rejected = [];
    let gasUsed = 0n;
    let fees = 0n;

    for (const tx of mempoolTxs.slice(0, limit)) {
      const result = applyTransaction(tempState, tx, false);
      if (result.ok) {
        accepted.push({ ...tx, hash: tx.hash || txHash(tx) });
        gasUsed += result.gasUsed;
        fees += result.fee;
      } else {
        rejected.push({ hash: tx.hash || txHash(tx), reason: result.reason });
      }
    }

    tempState.balances.set(producer, (tempState.balances.get(producer) || 0n) + this.blockReward + fees);

    const parent = this.head();
    const candidate = {
      version: 1,
      chainId: this.chainId,
      height: parent.height + 1,
      prevHash: parent.hash,
      timestamp: Date.now(),
      producer,
      transactions: accepted,
      txRoot: merkleRoot(accepted.map((tx) => tx.hash || txHash(tx))),
      stateRoot: stateRoot(tempState),
      gasUsed: gasUsed.toString(),
      baseFee: DEFAULT_GAS_PRICE.toString(),
      difficulty: this.difficulty,
      cumulativeWork: parent.cumulativeWork + workForDifficulty(this.difficulty),
      nonce: 0,
      _tempState: tempState,
      _rejected: rejected
    };
    candidate.consensusProof = createConsensusProof(candidate);
    candidate.consensusRoot = consensusRoot(candidate.consensusProof);
    return candidate;
  }

  mineBlock(producer, mempoolTxs = []) {
    const candidate = this.buildCandidate(producer, mempoolTxs);
    const prefix = "0".repeat(candidate.difficulty);

    do {
      candidate.nonce += 1;
      candidate.hash = blockHash(candidate);
    } while (!candidate.hash.startsWith(prefix));

    const { _tempState, _rejected, ...block } = candidate;
    block.seal = this.seal("BLOCK", block.hash, block);

    const result = this.acceptBlock(block);
    return { ...result, block, rejected: _rejected };
  }

  acceptBlock(block) {
    const validation = this.validateNextBlock(block);
    if (!validation.ok) return validation;

    this.state = validation.nextState;
    this.blocks.push(block);
    this.blockIndex.set(block.hash, block);
    this.seal("ACCEPT_BLOCK", block.hash, {
      height: block.height,
      producer: block.producer,
      txs: block.transactions.length,
      stateRoot: block.stateRoot
    });
    this.persist();
    return { ok: true, reason: "accepted" };
  }

  validateNextBlock(block) {
    const parent = this.head();
    if (block.chainId !== this.chainId) return { ok: false, reason: "wrong_chain" };
    if (block.prevHash !== parent.hash) return { ok: false, reason: "wrong_parent" };
    if (block.height !== parent.height + 1) return { ok: false, reason: "wrong_height" };
    if (!block.hash || block.hash !== blockHash(block)) return { ok: false, reason: "bad_hash" };
    if (!block.hash.startsWith("0".repeat(block.difficulty))) return { ok: false, reason: "bad_pow" };
    if (block.cumulativeWork !== parent.cumulativeWork + workForDifficulty(block.difficulty)) {
      return { ok: false, reason: "bad_work" };
    }
    if (block.txRoot !== merkleRoot(block.transactions.map((tx) => tx.hash || txHash(tx)))) {
      return { ok: false, reason: "bad_tx_root" };
    }
    if (!block.consensusRoot || !block.consensusProof) return { ok: false, reason: "missing_consensus" };
    if (block.consensusRoot !== consensusRoot(block.consensusProof)) return { ok: false, reason: "bad_consensus_root" };
    const consensus = verifyConsensusProof(block, block.consensusProof);
    if (!consensus.ok) return consensus;

    const nextState = cloneState(this.state);
    let gasUsed = 0n;
    let fees = 0n;

    for (const tx of block.transactions) {
      const result = applyTransaction(nextState, tx, true);
      if (!result.ok) return { ok: false, reason: `bad_tx:${result.reason}` };
      gasUsed += result.gasUsed;
      fees += result.fee;
    }

    nextState.balances.set(block.producer, (nextState.balances.get(block.producer) || 0n) + this.blockReward + fees);

    if (block.gasUsed !== gasUsed.toString()) return { ok: false, reason: "bad_gas_used" };
    if (block.stateRoot !== stateRoot(nextState)) return { ok: false, reason: "bad_state_root" };

    return { ok: true, nextState };
  }

  exportBlock(identifier) {
    if (identifier === "latest") return this.head();
    if (typeof identifier === "string" && identifier.startsWith("0x")) {
      const height = Number.parseInt(identifier, 16);
      return this.blocks[height] || null;
    }
    if (typeof identifier === "number") return this.blocks[identifier] || null;
    if (typeof identifier === "string" && this.blockIndex.has(identifier)) return this.blockIndex.get(identifier);
    return null;
  }

  stateRoot() {
    return stateRoot(this.state);
  }

  credit(address, amount) {
    this.state.balances.set(address, (this.state.balances.get(address) || 0n) + amount);
  }

  // ── Witness anchor — STELLA settlement ──────────────────────────────────
  anchorWitness(witness) {
    const wormSeal = this.seal("WITNESS", witness.snapaddr, witness);
    const chainAnchor = {
      chain_id:    this.chainId,
      height:      this.height(),
      block_hash:  this.head().hash,
      worm_index:  this.worm.length - 1,
      worm_seal:   wormSeal,
      anchored_at: new Date().toISOString(),
      seal:        wormSeal,
    };
    this.witnesses.set(witness.id, { witness, chainAnchor });
    this.persist();
    return chainAnchor;
  }

  getWitness(id) {
    return this.witnesses.get(id) || null;
  }

  listWitnesses(limit = 25) {
    return [...this.witnesses.values()].slice(-limit).reverse();
  }

  seal(kind, subject, payload) {
    const previous = this.worm.at(-1)?.seal || "0".repeat(64);
    const entry = {
      index: this.worm.length,
      kind,
      subject,
      timestamp: new Date().toISOString(),
      previous,
      payloadHash: sha256(payload)
    };
    entry.seal = sha256(entry);
    this.worm.push(entry);
    return entry.seal;
  }

  persist() {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true });
    writeJson(join(this.dataDir, "chain.json"), {
      chainId: this.chainId,
      difficulty: this.difficulty,
      blockReward: this.blockReward.toString(),
      blocks: this.blocks,
      worm: this.worm,
      witnesses: Object.fromEntries(this.witnesses),
      state: serializeState(this.state)
    });
  }

  load() {
    try {
      const snapshot = JSON.parse(readFileSync(join(this.dataDir, "chain.json"), "utf8"));
      this.chainId = snapshot.chainId;
      this.difficulty = snapshot.difficulty;
      this.blockReward = BigInt(snapshot.blockReward);
      this.blocks = snapshot.blocks || [];
      this.worm = snapshot.worm || [];
      this.witnesses = new Map(Object.entries(snapshot.witnesses || {}));
      this.state = deserializeState(snapshot.state);
      this.blockIndex = new Map(this.blocks.map((block) => [block.hash, block]));
      return this.blocks.length > 0;
    } catch {
      return false;
    }
  }
}

function applyTransaction(state, tx, requireSignature) {
  if (requireSignature && !verifyTransactionSignature(tx)) return { ok: false, reason: "bad_signature" };

  const from = tx.from;
  const to = tx.to;
  if (!from || !to) return { ok: false, reason: "missing_parties" };

  const value = fromHexOrDecimal(tx.value);
  const gasLimit = fromHexOrDecimal(tx.gasLimit, DEFAULT_GAS_LIMIT);
  const gasPrice = fromHexOrDecimal(tx.gasPrice, DEFAULT_GAS_PRICE);
  const fee = gasLimit * gasPrice;
  const gasUsed = gasLimit;

  if (value < 0n || fee < 0n) return { ok: false, reason: "negative_amount" };

  if (from !== "GENESIS") {
    const expectedNonce = state.nonces.get(from) || 0;
    if (Number(tx.nonce || 0) !== expectedNonce) return { ok: false, reason: "bad_nonce" };
    const balance = state.balances.get(from) || 0n;
    if (balance < value + fee) return { ok: false, reason: "insufficient_funds" };
    state.balances.set(from, balance - value - fee);
    state.nonces.set(from, expectedNonce + 1);
  }

  state.balances.set(to, (state.balances.get(to) || 0n) + value);
  return { ok: true, gasUsed, fee };
}

export function merkleRoot(items) {
  if (!items.length) return sha256("");
  let layer = items.map((item) => sha256(item));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha256(`${layer[i]}${layer[i + 1] || layer[i]}`));
    }
    layer = next;
  }
  return layer[0];
}

function stateRoot(state) {
  return sha256(serializeState(state));
}

function createEmptyState() {
  return {
    balances: new Map(),
    nonces: new Map()
  };
}

function cloneState(state) {
  return {
    balances: new Map(state.balances),
    nonces: new Map(state.nonces)
  };
}

function serializeState(state) {
  return {
    balances: Object.fromEntries([...state.balances.entries()].sort().map(([k, v]) => [k, v.toString()])),
    nonces: Object.fromEntries([...state.nonces.entries()].sort())
  };
}

function deserializeState(state = {}) {
  return {
    balances: new Map(Object.entries(state.balances || {}).map(([k, v]) => [k, BigInt(v)])),
    nonces: new Map(Object.entries(state.nonces || {}).map(([k, v]) => [k, Number(v)]))
  };
}

function workForDifficulty(difficulty) {
  return Math.pow(16, difficulty);
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableStringify(payload)}\n`);
}
