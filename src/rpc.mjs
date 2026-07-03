import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHexOrDecimal, toHexQuantity, txHash } from "./crypto.mjs";
import { CONSENSUS_AGENTS, CONSENSUS_ARCHITECTURE } from "./consensus.mjs";
import { createWitness } from "./witness.mjs";
import { stellarAnchor, settlementCertificate } from "./anchor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAGMAD_URL = process.env.MAGMAD_URL || "http://127.0.0.1:3000";

export class JsonRpcServer {
  constructor({ host = "127.0.0.1", port = 8545, chain, mempool, produceBlock, peers }) {
    this.host = host;
    this.port = port;
    this.chain = chain;
    this.mempool = mempool;
    this.produceBlock = produceBlock;
    this.peers = peers;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  async handle(req, res) {
    // ── STELLA REST endpoints ──────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, height: this.chain.height(), head: this.chain.head().hash });
    }

    if (req.method === "GET" && req.url === "/stella") {
      const html = readFileSync(join(__dirname, "../stella-ui.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
      return res.end(html);
    }

    if (req.method === "POST" && req.url === "/stella/anchor") {
      try {
        const body = await readBody(req);
        const { witness } = JSON.parse(body);
        const chainAnchor = this.chain.anchorWitness(witness);
        const publicAnchor = stellarAnchor(witness);
        const cert         = settlementCertificate(witness, chainAnchor, publicAnchor);
        return send(res, 200, cert);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (req.method === "GET" && req.url.startsWith("/stella/witness/")) {
      const id = req.url.slice("/stella/witness/".length);
      const entry = this.chain.getWitness(id);
      return entry ? send(res, 200, entry) : send(res, 404, { error: "not_found" });
    }

    if (req.method === "GET" && req.url === "/stella/witnesses") {
      return send(res, 200, this.chain.listWitnesses());
    }

    if (req.method === "POST" && req.url === "/stella/execute") {
      try {
        const body    = await readBody(req);
        const { action, session_id } = JSON.parse(body);
        const sessionId = session_id || `stella_${Date.now()}`;
        const stages  = await collectMagmadStages(action, sessionId);
        const witness = createWitness(action, stages, sessionId);
        const chainAnchor = this.chain.anchorWitness(witness);
        const publicAnchor = stellarAnchor(witness);
        const cert         = settlementCertificate(witness, chainAnchor, publicAnchor);
        return send(res, 200, { witness, certificate: cert, stages });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

    try {
      const body = await readBody(req);
      const call = JSON.parse(body || "{}");
      const result = await this.dispatch(call.method, call.params || []);
      return send(res, 200, { jsonrpc: "2.0", id: call.id ?? null, result });
    } catch (error) {
      return send(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: error.message }
      });
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case "web3_clientVersion":
        return "SnapKittyChain/0.1.0/node20";
      case "net_version":
        return String(this.chain.chainId);
      case "eth_chainId":
        return toHexQuantity(this.chain.chainId);
      case "eth_blockNumber":
        return toHexQuantity(this.chain.height());
      case "eth_getBalance":
        return toHexQuantity(this.chain.getBalance(params[0]));
      case "eth_getBlockByNumber":
        return this.formatBlock(this.chain.exportBlock(params[0] || "latest"));
      case "eth_getBlockByHash":
        return this.formatBlock(this.chain.exportBlock(params[0]));
      case "eth_sendRawTransaction":
      case "sk_sendTransaction":
        return this.submitTransaction(params[0]);
      case "sk_faucet":
        return this.chain.faucet(params[0], params[1] || "1000000000000000000");
      case "sk_getMempool":
        return this.mempool.snapshot(Number(params[0] || 100));
      case "sk_produceBlock":
        return this.produceBlock("rpc").block.hash;
      case "sk_getWorm":
        return this.chain.worm.slice(-Number(params[0] || 25));
      case "sk_getPeers":
        return this.peers ? this.peers() : [];
      case "sk_getValidators":
        return {
          architecture: CONSENSUS_ARCHITECTURE,
          quorum: 3,
          validators: CONSENSUS_AGENTS
        };
      case "sk_getConsensusProof": {
        const block = this.chain.exportBlock(params[0] || "latest");
        return block?.consensusProof || null;
      }
      case "sk_anchorWitness": {
        const witness     = params[0];
        const chainAnchor = this.chain.anchorWitness(witness);
        const publicAnchor = stellarAnchor(witness);
        return settlementCertificate(witness, chainAnchor, publicAnchor);
      }
      case "sk_getWitness":
        return this.chain.getWitness(params[0]);
      case "sk_listWitnesses":
        return this.chain.listWitnesses(Number(params[0] || 25));
      default:
        throw new Error(`unknown_method:${method}`);
    }
  }

  submitTransaction(raw) {
    const tx = decodeTx(raw);
    tx.hash = tx.hash || txHash(tx);
    const result = this.mempool.add(tx);
    if (!result.accepted) throw new Error(result.reason);
    return result.tx.hash;
  }

  formatBlock(block) {
    if (!block) return null;
    return {
      number: toHexQuantity(block.height),
      hash: `0x${block.hash}`,
      parentHash: `0x${block.prevHash}`,
      timestamp: toHexQuantity(block.timestamp),
      miner: block.producer,
      gasUsed: toHexQuantity(fromHexOrDecimal(block.gasUsed)),
      transactions: block.transactions,
      stateRoot: `0x${block.stateRoot}`,
      receiptsRoot: `0x${block.seal}`,
      consensusRoot: `0x${block.consensusRoot}`,
      consensusProof: block.consensusProof || null,
      extraData: "0x534e41504b49545459"
    };
  }
}

function decodeTx(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw !== "string") throw new Error("transaction_must_be_object_or_hex_json");
  const text = raw.startsWith("0x")
    ? Buffer.from(raw.slice(2), "hex").toString("utf8")
    : raw;
  return JSON.parse(text);
}

// ── STELLA: collect magmad SSE stages ──────────────────────────────────────

async function collectMagmadStages(action, sessionId) {
  const resp = await fetch(`${MAGMAD_URL}/api/v1/orchestrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, session_id: sessionId }),
    signal: AbortSignal.timeout(30_000),
  });

  const stages = [];
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try { stages.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  return stages;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}
