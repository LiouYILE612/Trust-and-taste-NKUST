// ✅ server.js - Plan A (no explicit login) + MPT / XRP / RLUSD Payment + RLUSD TrustLine Check + NFT Mint/Offer
// - /create-order: idempotent create Payment payload directly (no login)
// - /buy/status: strict tx verification + mint/offer + cache result
// - /rlusd/trustline: create TrustSet payload for STORE wallet to scan/sign in Xaman
// - /rlusd/trustline/status: check if STORE_ADDRESS already has RLUSD trust line
// - Do NOT delete order immediately; mark completed + TTL sweep cleanup
// - Keep AI ordering + IPFS/Pinata fallback + local meta proxy

import dotenv from "dotenv";
import express from "express";
import { XummSdk } from "xumm-sdk";
import { createRequire } from "module";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";

dotenv.config();
const require = createRequire(import.meta.url);
const xrpl = require("xrpl");

const app = express();
app.use(express.static("public"));
app.use(express.json());

// ===== Utils (put before config if config depends on them) =====
function safeUpper(s) {
  return (s || "").toString().trim().toUpperCase();
}

function normalizePaymentMethod(method) {
  const m = (method || "mpt").toString().trim().toLowerCase();
  if (["mpt", "xrp", "rlusd"].includes(m)) return m;
  throw new Error(`Unsupported payment_method: ${method}`);
}

function normalizeCurrencyCode(code) {
  const raw = (code || "").trim();
  if (!raw) throw new Error("Missing currency code");

  // 3-char standard code: USD / EUR / etc.
  if (/^[A-Za-z0-9]{3}$/.test(raw)) {
    return raw.toUpperCase();
  }

  // already 40-char hex
  if (/^[A-Fa-f0-9]{40}$/.test(raw)) {
    return raw.toUpperCase();
  }

  // non-standard code -> convert ASCII to 160-bit hex (40 chars)
  const hex = Buffer.from(raw, "utf8").toString("hex").toUpperCase();
  if (hex.length > 40) {
    throw new Error(`Currency code too long for XRPL non-standard format: ${raw}`);
  }
  return hex.padEnd(40, "0");
}

function toHexUri(urlStr) {
  return Buffer.from(urlStr, "utf8").toString("hex").toUpperCase();
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function getPinataAuthHeader(raw = process.env.PINATA_JWT || "") {
  const v = (raw || "").toString().trim();
  if (!v) throw new Error("Missing PINATA_JWT");
  return v.toLowerCase().startsWith("bearer ") ? v : `Bearer ${v}`;
}

// ===== Config =====
const BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/+$/, "") || "http://localhost:3000";
const XRPL_ENDPOINT = process.env.XRPL_ENDPOINT || "wss://s.altnet.rippletest.net:51233";

const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;

const STORE_ADDRESS = (process.env.STORE_ADDRESS || "").trim();
const STORE_SECRET = (process.env.STORE_SECRET || "").trim(); // optional, only if you later want backend auto TrustSet
const ISSUER_SECRET = (process.env.ISSUER_SECRET || "").trim();
const KFD_MPT_ISSUANCE_ID = (process.env.KFD_MPT_ISSUANCE_ID || "").trim().toUpperCase();

const RLUSD_ISSUER = (process.env.RLUSD_ISSUER || "").trim();
const RLUSD_CURRENCY = normalizeCurrencyCode(process.env.RLUSD_CURRENCY || "RLUSD");

// TTL (ms)
const ORDER_TTL_MS = Number(process.env.ORDER_TTL_MS || 10 * 60 * 1000); // default 10 min
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 60 * 1000); // default 60 sec
const CREATE_ORDER_CACHE_MS = Number(process.env.CREATE_ORDER_CACHE_MS || 60 * 1000); // 1 min
const TRUSTLINE_CACHE_MS = Number(process.env.TRUSTLINE_CACHE_MS || 30 * 1000); // 30 sec

if (!XUMM_API_KEY || !XUMM_API_SECRET) {
  console.error("❌ Missing XUMM_API_KEY / XUMM_API_SECRET");
  process.exit(1);
}
if (!STORE_ADDRESS) {
  console.error("❌ Missing STORE_ADDRESS in .env");
  process.exit(1);
}
if (!ISSUER_SECRET) {
  console.error("❌ Missing ISSUER_SECRET in .env (needed for NFTokenMint / NFTokenCreateOffer)");
  process.exit(1);
}
if (!KFD_MPT_ISSUANCE_ID) {
  console.error("❌ Missing KFD_MPT_ISSUANCE_ID in .env");
  process.exit(1);
}
if (!RLUSD_ISSUER) {
  console.warn("⚠️ Missing RLUSD_ISSUER in .env (RLUSD payment will fail if used)");
}
if (!RLUSD_CURRENCY) {
  console.warn("⚠️ Missing RLUSD_CURRENCY in .env (RLUSD payment will fail if used)");
}

const xumm = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET);

// ===== OpenAI =====
const rawOpenAiKey = process.env.OPENAI_API_KEY || "";
const openAiKeyTrimmed = rawOpenAiKey.trim();
const OPENAI_PROJECT = (process.env.OPENAI_PROJECT || "").trim();
const OPENAI_ORG = (process.env.OPENAI_ORG || "").trim();

if (openAiKeyTrimmed.startsWith("sk-proj-") && !OPENAI_PROJECT) {
  console.error("❌ 使用 sk-proj- 但缺少 OPENAI_PROJECT=proj_xxx，請在 .env 補上！");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: openAiKeyTrimmed,
  project: OPENAI_PROJECT || undefined,
  organization: OPENAI_ORG || undefined,
});

console.log("DEBUG: OPENAI_API_KEY present?", !!process.env.OPENAI_API_KEY);

// ===== In-memory state =====
const processedTx = new Set();                 // txid processed (mint started)
const txCache = new Map();                     // txid -> final response
const inflight = new Map();                    // txid -> Promise
const ordersByPaymentPayload = new Map();      // payload_uuid -> order
const completedByPayload = new Map();          // payload_uuid -> { result, completedAt }
const memoryMeta = {};

// ✅ create-order idempotency / dedupe
const createOrderInflight = new Map();         // orderKey -> Promise<response>
const createOrderCache = new Map();            // orderKey -> { response, createdAt }

// ✅ trustline status cache
const trustlineStatusCache = new Map();        // key -> { ok, checkedAt }

// ===== Paths =====
const metaDir = path.join(process.cwd(), "public", "meta");
if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

// ===== Products =====
const products = {
  1: { name: "Classic Americano", name_zh: "經典美式咖啡", price: 1, imageFile: "image1.png" },
  2: { name: "Latte", name_zh: "拿鐵咖啡", price: 2, imageFile: "image2.png" },
  3: { name: "Tiramisu", name_zh: "提拉米蘇", price: 2, imageFile: "image3.png" },
};

// ===== More Utils =====
function calcOrderTotal(items = []) {
  return items.reduce(
    (sum, i) => sum + (i.qty || 1) * (products[i.product_id]?.price || 0),
    0
  );
}

function buildPaymentAmount({ paymentMethod, total }) {
  if (paymentMethod === "xrp") {
    return xrpl.xrpToDrops(total.toString());
  }

  if (paymentMethod === "rlusd") {
    if (!RLUSD_ISSUER) throw new Error("Missing RLUSD_ISSUER");
    if (!RLUSD_CURRENCY) throw new Error("Missing RLUSD_CURRENCY");

    return {
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
      value: total.toString(),
    };
  }

  if (paymentMethod === "mpt") {
    return {
      mpt_issuance_id: KFD_MPT_ISSUANCE_ID,
      value: total.toString(),
    };
  }

  throw new Error(`Unsupported payment method: ${paymentMethod}`);
}

function buildCreateOrderKey({ items, buyer, paymentMethod }) {
  return `${paymentMethod}|${buyer || ""}|${stableStringify(items || [])}`;
}

function getTrustlineCacheKey({ account, issuer, currency }) {
  return `${account}:${issuer}:${safeUpper(currency)}`;
}

async function getTrustLineStatus({ client, account, issuer, currency }) {
  const resp = await client.request({
    command: "account_lines",
    account,
    peer: issuer,
  });

  const lines = resp?.result?.lines || [];
  const targetCurrency = safeUpper(currency);

  const line = lines.find((l) => safeUpper(l.currency) === targetCurrency);

  if (!line) {
    return {
      exists: false,
      peer_authorized: false,
      authorized: false,
      raw: null,
    };
  }

  return {
    exists: true,
    peer_authorized: line.peer_authorized === true,
    authorized: line.authorized === true,
    raw: line,
  };
}

async function checkStoreRlusdTrustLine() {
  if (!RLUSD_ISSUER || !RLUSD_CURRENCY) {
    return {
      exists: false,
      peer_authorized: false,
      authorized: false,
      checkedAt: Date.now(),
    };
  }

  const cacheKey = getTrustlineCacheKey({
    account: STORE_ADDRESS,
    issuer: RLUSD_ISSUER,
    currency: RLUSD_CURRENCY,
  });

  const cached = trustlineStatusCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.checkedAt < TRUSTLINE_CACHE_MS) {
    return cached;
  }

  const client = new xrpl.Client(XRPL_ENDPOINT);
  await client.connect();
  try {
    const status = await getTrustLineStatus({
      client,
      account: STORE_ADDRESS,
      issuer: RLUSD_ISSUER,
      currency: RLUSD_CURRENCY,
    });

    const result = {
      ...status,
      checkedAt: now,
    };

    trustlineStatusCache.set(cacheKey, result);
    return result;
  } finally {
    await client.disconnect();
  }
}

function invalidateStoreRlusdTrustlineCache() {
  const cacheKey = getTrustlineCacheKey({
    account: STORE_ADDRESS,
    issuer: RLUSD_ISSUER,
    currency: RLUSD_CURRENCY,
  });
  trustlineStatusCache.delete(cacheKey);
}

/**
 * Verify txid is a validated successful Payment that matches:
 * - Payment
 * - Account == expectedBuyer
 * - Destination == STORE_ADDRESS
 * - Amount matches expected asset and total
 * - meta.TransactionResult == tesSUCCESS
 *
 * If not validated yet, return ok:false reason=not_validated_yet
 */
async function verifyPaymentTx({
  client,
  txid,
  expectedBuyer,
  expectedTotal,
  paymentMethod,
}) {
  let txResp;
  try {
    txResp = await client.request({ command: "tx", transaction: txid });
  } catch (e) {
    return {
      ok: false,
      reason: "not_validated_yet",
      details: { message: e?.data?.error || e?.message || String(e) },
    };
  }

  const tx = txResp?.result;
  if (!tx) return { ok: false, reason: "tx_not_found" };
  if (tx.validated === false) return { ok: false, reason: "not_validated_yet" };

  if (tx.TransactionType !== "Payment") return { ok: false, reason: "not_payment" };

  const txAccount = (tx.Account || "").trim();
  const txDest = (tx.Destination || "").trim();

  if (txAccount !== expectedBuyer) {
    return { ok: false, reason: "buyer_mismatch", details: { txAccount, expectedBuyer } };
  }
  if (txDest !== STORE_ADDRESS) {
    return { ok: false, reason: "destination_mismatch", details: { txDest, expected: STORE_ADDRESS } };
  }

  const resultCode = tx.meta?.TransactionResult;
  if (!resultCode) return { ok: false, reason: "not_validated_yet" };
  if (resultCode !== "tesSUCCESS") {
    return { ok: false, reason: "not_success", details: { resultCode } };
  }

  const amt = tx.Amount;

  // XRP
  if (paymentMethod === "xrp") {
    if (typeof amt !== "string") {
      return { ok: false, reason: "amount_not_xrp_string" };
    }

    const expectedDrops = xrpl.xrpToDrops(expectedTotal.toString());
    if (amt !== expectedDrops) {
      return {
        ok: false,
        reason: "amount_mismatch",
        details: { value: amt, expected: expectedDrops },
      };
    }

    return { ok: true };
  }

  // RLUSD (issued token)
  if (paymentMethod === "rlusd") {
    if (!amt || typeof amt !== "object") {
      return { ok: false, reason: "amount_not_token_object" };
    }

    const currency = safeUpper(amt.currency);
    const issuer = (amt.issuer || "").trim();
    const value = (amt.value ?? "").toString();

    if (currency !== safeUpper(RLUSD_CURRENCY)) {
      return {
        ok: false,
        reason: "currency_mismatch",
        details: { currency, expected: safeUpper(RLUSD_CURRENCY) },
      };
    }

    if (issuer !== RLUSD_ISSUER) {
      return {
        ok: false,
        reason: "issuer_mismatch",
        details: { issuer, expected: RLUSD_ISSUER },
      };
    }

    if (value !== expectedTotal.toString()) {
      return {
        ok: false,
        reason: "amount_mismatch",
        details: { value, expected: expectedTotal.toString() },
      };
    }

    return { ok: true };
  }

  // MPT
  if (paymentMethod === "mpt") {
    if (!amt || typeof amt !== "object") {
      return { ok: false, reason: "amount_not_object" };
    }

    const issuance = safeUpper(amt.mpt_issuance_id);
    const value = (amt.value ?? "").toString();

    if (issuance !== KFD_MPT_ISSUANCE_ID) {
      return {
        ok: false,
        reason: "issuance_mismatch",
        details: { issuance, expected: KFD_MPT_ISSUANCE_ID },
      };
    }

    if (value !== expectedTotal.toString()) {
      return {
        ok: false,
        reason: "amount_mismatch",
        details: { value, expected: expectedTotal.toString() },
      };
    }

    return { ok: true };
  }

  return { ok: false, reason: "unsupported_payment_method" };
}

// ===== Optional: MPT authorize payload (Plan A helper) =====
app.post("/mpt/authorize", async (req, res) => {
  try {
    const { buyer } = req.body || {};
    const txjson = {
      TransactionType: "MPTokenAuthorize",
      MPTokenIssuanceID: KFD_MPT_ISSUANCE_ID,
      ...(buyer ? { Account: buyer } : {}),
    };

    const payload = await xumm.payload.create({
      txjson,
      options: {
        expire: 300,
        return_url: { app: "xumm://close", web: `${BASE_URL}/index.html` },
      },
    });

    if (!payload?.uuid) throw new Error("Failed to create MPT authorize payload");

    return res.json({
      authorize_qr: payload?.refs?.qr_png || null,
      authorize_url: payload?.next?.always || null,
      payload_uuid: payload.uuid,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== RLUSD trustline setup payload for STORE wallet =====
// 用商店自己的 Xaman 錢包掃描並簽名
app.post("/rlusd/trustline", async (req, res) => {
  try {
    const payload = await xumm.payload.create({
      txjson: {
        TransactionType: "TrustSet",
        LimitAmount: {
          currency: RLUSD_CURRENCY,
          issuer: RLUSD_ISSUER,
          value: "1000000000",
        },
      },
      options: {
        expire: 300,
        return_url: { app: "xumm://close", web: `${BASE_URL}/index.html` },
      },
    });

    if (!payload?.uuid) {
      throw new Error("Failed to create TrustSet payload");
    }

    // trustline may change after signing; invalidate short cache
    invalidateStoreRlusdTrustlineCache();

    return res.json({
      payload_uuid: payload.uuid,
      qr: payload?.refs?.qr_png || null,
      url: payload?.next?.always || null,
      account: STORE_ADDRESS,
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/rlusd/trustline/status", async (req, res) => {
  try {
    const status = await checkStoreRlusdTrustLine();

    return res.json({
      ok: true,
      has_trustline: status.exists,
      peer_authorized: status.peer_authorized,
      authorized: status.authorized,
      account: STORE_ADDRESS,
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
      raw: status.raw || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ===== Create Order (Payment payload) =====
app.post("/create-order", async (req, res) => {
  const startedAt = Date.now();

  try {
    const { items, buyer, payment_method } = req.body || {};
    const paymentMethod = normalizePaymentMethod(payment_method || "mpt");

    const total = calcOrderTotal(items);
    if (total <= 0) throw new Error("Invalid total");

    const orderKey = buildCreateOrderKey({ items, buyer, paymentMethod });

    // ✅ reuse recent identical create-order response
    const cached = createOrderCache.get(orderKey);
    if (cached && startedAt - cached.createdAt < CREATE_ORDER_CACHE_MS) {
      console.log("♻️ Reuse cached /create-order response:", orderKey);
      return res.json(cached.response);
    }

    // ✅ reuse inflight promise if same request arrives concurrently
    if (createOrderInflight.has(orderKey)) {
      console.log("⏳ Reuse inflight /create-order:", orderKey);
      const inflightResp = await createOrderInflight.get(orderKey);
      return res.json(inflightResp);
    }

    const job = (async () => {
      // ✅ RLUSD payment requires STORE_ADDRESS to already have trustline
      if (paymentMethod === "rlusd") {
        const storeTrustOk = await checkStoreRlusdTrustLine();
        if (!storeTrustOk) {
          const err = new Error(
            "Store wallet missing RLUSD trust line. Please run /rlusd/trustline and sign it with the STORE wallet in Xaman first."
          );
          err.code = "STORE_RLUSD_TRUSTLINE_MISSING";
          throw err;
        }
      }

      const txjson = {
        TransactionType: "Payment",
        Destination: STORE_ADDRESS,
        Amount: buildPaymentAmount({ paymentMethod, total }),
        ...(buyer ? { Account: buyer } : {}),
      };

      console.log("DEBUG /create-order paymentMethod =", paymentMethod);
      console.log("DEBUG /create-order txjson =", JSON.stringify(txjson, null, 2));

      const payload = await xumm.payload.create({
        txjson,
        options: {
          expire: 300,
          return_url: {
            app: "xumm://close",
            web: `${BASE_URL}/index.html`,
          },
        },
      });

      console.log("DEBUG /create-order payload =", JSON.stringify(payload, null, 2));

      if (!payload || !payload.uuid) {
        throw new Error("Xumm payload.create returned empty payload");
      }

      ordersByPaymentPayload.set(payload.uuid, {
        items,
        total,
        buyer: buyer || null,
        paymentMethod,
        status: "created",
        createdAt: Date.now(),
        completedAt: null,
        txid: null,
        orderKey,
      });

      const responseBody = {
        total_price: total,
        payment_method: paymentMethod,
        xumm_qr: payload?.refs?.qr_png || null,
        xumm_payload_url: payload?.next?.always || null,
        payload_uuid: payload.uuid,
      };

      createOrderCache.set(orderKey, {
        response: responseBody,
        createdAt: Date.now(),
      });

      return responseBody;
    })();

    createOrderInflight.set(orderKey, job);

    try {
      const result = await job;
      return res.json(result);
    } finally {
      createOrderInflight.delete(orderKey);
    }
  } catch (err) {
    console.error("❌ /create-order error:", err);

    const statusCode =
      err?.code === "STORE_RLUSD_TRUSTLINE_MISSING" ? 400 : 500;

    return res.status(statusCode).json({
      error: err.message,
      code: err.code || "CREATE_ORDER_FAILED",
    });
  }
});

// ===== Buy Status (verify payment -> mint -> offer -> accept payloads) =====
app.get("/buy/status", async (req, res) => {
  const payload_uuid = req.query.payload_uuid;
  if (!payload_uuid) return res.status(400).json({ error: "Missing payload_uuid" });

  try {
    // If order already swept, still allow returning completion for a while
    const completed = completedByPayload.get(payload_uuid);
    if (completed?.result) return res.json(completed.result);

    const order = ordersByPaymentPayload.get(payload_uuid);
    if (!order) {
      return res.json({ status: "completed_or_expired" });
    }

    // If already marked completed, return cached result if present
    if (order.status === "completed") {
      const c = completedByPayload.get(payload_uuid);
      if (c?.result) return res.json(c.result);
      return res.json({ status: "completed_or_expired" });
    }

    const payload = await xumm.payload.get(payload_uuid);
    if (!payload?.meta) return res.status(404).json({ error: "Payload not found" });
    if (!payload?.meta?.signed) return res.json({ status: "pending" });

    const buyer = payload.response.account;
    const txid = payload.response.txid;
    if (!txid) return res.status(500).json({ status: "error", error: "No txid" });

    // Fill buyer once (Plan A)
    if (!order.buyer) order.buyer = buyer;
    // Freeze txid for this order
    if (!order.txid) order.txid = txid;

    // Prevent buyer mismatch
    if (buyer !== order.buyer) {
      return res.status(400).json({ status: "error", error: "Buyer mismatch for this order" });
    }

    // If already have tx cached, return it
    if (txCache.has(txid)) return res.json(txCache.get(txid));
    if (inflight.has(txid)) return res.json({ status: "pending" });
    if (processedTx.has(txid)) return res.json({ status: "pending" });

    const jobPromise = (async () => {
      const client = new xrpl.Client(XRPL_ENDPOINT);
      await client.connect();

      const v = await verifyPaymentTx({
        client,
        txid,
        expectedBuyer: order.buyer,
        expectedTotal: order.total,
        paymentMethod: order.paymentMethod || "mpt",
      });

      if (!v.ok) {
        await client.disconnect();
        if (v.reason === "not_validated_yet") return { status: "pending" };
        return { status: "error", error: `Payment verification failed: ${v.reason}`, details: v.details || null };
      }

      processedTx.add(txid);
      console.log(`✅ Verified ${order.paymentMethod || "mpt"} payment: buyer=${buyer} total=${order.total} tx=${txid}`);

      const issuerWallet = xrpl.Wallet.fromSeed(ISSUER_SECRET);
      const mintedNFTs = [];
      const acceptQrList = [];

      // Optional IPFS helper
      const uploadModule = await import("./nft/uploadIPFS.js").catch(() => null);
      const uploadToIPFS =
        uploadModule && (uploadModule.default || uploadModule.uploadToIPFS || uploadModule)
          ? (uploadModule.default || uploadModule.uploadToIPFS || uploadModule)
          : null;

      const FormDataModule = await import("form-data").catch(() => null);
      const FormData = FormDataModule ? FormDataModule.default : null;

      async function pinLocalImageAndMetadata(foundPath, p, metaJson) {
        if (!FormData) throw new Error("FormData required for Pinata fallback");
        const form = new FormData();
        form.append("file", fs.createReadStream(foundPath));
        form.append("pinataMetadata", JSON.stringify({ name: p.name }));
        form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

        const pinFileRes = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", form, {
          maxBodyLength: Infinity,
          headers: { ...form.getHeaders(), Authorization: getPinataAuthHeader() },
          timeout: Number(process.env.PINATA_WAIT_MS || 60000),
        });

        const imageCid = pinFileRes?.data?.IpfsHash;
        const imageURL = `https://gateway.pinata.cloud/ipfs/${imageCid}`;
        metaJson.image = imageURL;

        const pinJsonRes = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", metaJson, {
          headers: { "Content-Type": "application/json", Authorization: getPinataAuthHeader() },
          timeout: Number(process.env.PINATA_TIMEOUT_MS || 15000),
        });

        const metaCid = pinJsonRes?.data?.IpfsHash;
        const metadataURI = `ipfs://${metaCid}`;

        try {
          const corrected = { ...metaJson };
          if (corrected.image && corrected.image.startsWith("ipfs://")) {
            corrected.image = `https://gateway.pinata.cloud/ipfs/${corrected.image.replace("ipfs://", "")}`;
          }
          const metaPath = path.join(metaDir, `${metaCid}.json`);
          if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, JSON.stringify(corrected, null, 2), "utf8");
          memoryMeta[metaCid] = corrected;
        } catch {}

        await new Promise((r) => setTimeout(r, 200));
        return { finalMetadataURI: metadataURI, finalImageURL: imageURL };
      }

      for (const it of order.items || []) {
        const p = products[it.product_id];
        if (!p) continue;
        const qty = it.qty || 1;

        for (let i = 0; i < qty; i++) {
          try {
            const metaJson = {
              name: `${p.name}`,
              description: `Purchased: ${p.name}`,
              attributes: [{ trait_type: "Product", value: p.name }],
            };

            let finalMetadataURI = null;
            let finalImageURL = null;

            // Local image fallback
            const tryPaths = [];
            if (p.imageFile) tryPaths.push(path.join(process.cwd(), "public", "images", p.imageFile));

            let foundPath = null;
            for (const t of tryPaths) {
              if (fs.existsSync(t)) {
                foundPath = t;
                break;
              }
            }

            if (foundPath) {
              if (uploadToIPFS) {
                try {
                  const up = await uploadToIPFS(foundPath, p.name, metaJson.description, metaJson);
                  if (up) {
                    finalMetadataURI = up.metadataURI;
                    finalImageURL = up.imageURL;
                  }
                } catch {}
              }
              if (!finalMetadataURI) {
                const r = await pinLocalImageAndMetadata(foundPath, p, metaJson);
                finalMetadataURI = r.finalMetadataURI;
                finalImageURL = r.finalImageURL;
              }
            }

            // Metadata fallback: pin JSON only
            if (!finalMetadataURI) {
              const r = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", metaJson, {
                headers: { "Content-Type": "application/json", Authorization: getPinataAuthHeader() },
              });
              if (r?.data?.IpfsHash) finalMetadataURI = `ipfs://${r.data.IpfsHash}`;
            }

            if (!finalMetadataURI) throw new Error("Failed to generate metadataURI");
            const metaCid = finalMetadataURI.replace("ipfs://", "");

            // Local meta save
            try {
              const metaPath = path.join(metaDir, `${metaCid}.json`);
              const metaObj = { ...metaJson, image: finalImageURL || metaJson.image };
              if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, JSON.stringify(metaObj, null, 2));
            } catch {}

            // Mint
            const proxiedUrl = `${BASE_URL}/nft/meta/${metaCid}`;
            const mintTx = {
              TransactionType: "NFTokenMint",
              Account: issuerWallet.classicAddress,
              URI: toHexUri(proxiedUrl),
              Flags: 8,
              NFTokenTaxon: 0,
            };

            const mint = await client.submitAndWait(
              issuerWallet.sign(await client.autofill(mintTx)).tx_blob
            );

            const nftId =
              mint.result?.meta?.nftoken_id ||
              (mint.result?.meta?.AffectedNodes || []).find((n) => n.CreatedNode?.NewFields?.NFTokenID)
                ?.CreatedNode?.NewFields?.NFTokenID;

            if (!nftId) throw new Error("Mint failed, no NFTokenID");
            mintedNFTs.push({ name: p.name, image: finalImageURL, nftId });

            // Offer to buyer (free)
            const offerTx = {
              TransactionType: "NFTokenCreateOffer",
              Account: issuerWallet.classicAddress,
              NFTokenID: nftId,
              Destination: buyer,
              Amount: "0",
              Flags: 1,
            };

            const offer = await client.submitAndWait(
              issuerWallet.sign(await client.autofill(offerTx)).tx_blob
            );

            const offerId =
              offer.result?.meta?.offer_id ||
              (offer.result?.meta?.AffectedNodes || []).find((n) => n.CreatedNode?.NewFields?.NFTokenOfferID)
                ?.CreatedNode?.NewFields?.NFTokenOfferID;

            if (!offerId) throw new Error("Offer failed, no NFTokenOfferID");

            // Buyer accept offer via XUMM payload
            const acceptPayload = await xumm.payload.create({
              txjson: { TransactionType: "NFTokenAcceptOffer", Account: buyer, NFTokenSellOffer: offerId },
              options: { expire: 600, return_url: { app: "xumm://close", web: `${BASE_URL}/index.html` } },
            });

            acceptQrList.push({
              product: p.name,
              qr: acceptPayload?.refs?.qr_png || null,
              url: acceptPayload?.next?.always || null,
            });
          } catch (e) {
            console.error("Mint error:", e?.message || e);
          }
        }
      }

      await client.disconnect();

      return {
        status: "success",
        payment_method: order.paymentMethod || "mpt",
        total_nfts: mintedNFTs.length,
        nfts: mintedNFTs,
        accept_qr_list: acceptQrList,
      };
    })();

    inflight.set(txid, jobPromise);
    const result = await jobPromise;

    // If still pending (not validated), do NOT finalize or cache as success
    if (result?.status === "pending") {
      inflight.delete(txid);
      return res.json({ status: "pending" });
    }

    // Cache by txid
    txCache.set(txid, result);
    inflight.delete(txid);

    // Mark completed + cache by payload_uuid for TTL window
    if (result?.status === "success") {
      order.status = "completed";
      order.completedAt = Date.now();
      ordersByPaymentPayload.set(payload_uuid, order);

      completedByPayload.set(payload_uuid, {
        result,
        completedAt: Date.now(),
      });
    }

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== AI ordering =====
app.post("/ai-order", async (req, res) => {
  try {
    const { text, lang } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "missing text" });

    const targetLang = lang === "zh" ? "Traditional Chinese (繁體中文)" : "English";
    const catalogText = Object.entries(products)
      .map(([id, p]) => `${id}. ${p.name} / ${p.name_zh || p.name} ($${p.price})`)
      .join("\n");

    const functions = [
      {
        name: "order_intent",
        description: "Return parsed order intent and items.",
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string", enum: ["order", "checkout", "help"] },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  product: { type: "string" },
                  qty: { type: "integer", minimum: 1 },
                },
                required: ["product"],
              },
            },
            checkout: { type: "boolean" },
          },
          required: ["intent", "items"],
        },
      },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a smart barista AI.
Rules:
1. Reply in ${targetLang}.
2. If user mentions ANY product (English or Chinese), interpret as order.
3. Even single words (e.g. "Latte", "拿鐵") are orders.
4. Only return "help" if input is a greeting unrelated to ordering.
5. Current Menu:\n${catalogText}`,
        },
        { role: "user", content: text },
      ],
      functions,
      function_call: "auto",
      temperature: 0.1,
      max_tokens: 400,
    });

    const choice = resp.choices?.[0];
    let parsed = null;

    if (choice?.message?.function_call) {
      try {
        parsed = JSON.parse(choice.message.function_call.arguments);
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = JSON.parse(choice?.message?.content || "");
      } catch {
        parsed = null;
      }
    }

    if (!parsed) parsed = { intent: "help", items: [], raw_text: choice?.message?.content || text };
    if (!Array.isArray(parsed.items)) parsed.items = [];

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, "");
    parsed.items = parsed.items.map((it) => {
      const name = norm(it.product);
      let pid = null;
      for (const k of Object.keys(products)) {
        const p = products[k];
        const pnEn = norm(p.name);
        const pnZh = norm(p.name_zh);
        if (pnEn === name || pnZh === name || name.includes(pnEn) || name.includes(pnZh)) {
          pid = k;
          break;
        }
      }
      return { ...it, product_id: pid };
    });

    const actions = [];
    for (const it of parsed.items) {
      if (it.product_id) actions.push({ type: "add_to_cart", product_id: it.product_id, qty: it.qty || 1 });
    }
    if (parsed.intent === "checkout" || parsed.checkout) actions.push({ type: "checkout" });

    return res.json({ ok: true, parsed, actions });
  } catch (err) {
    console.error("AI Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== NFT Meta proxy =====
app.get("/nft/meta/:key", async (req, res) => {
  const metaKey = req.params.key;
  const metaPath = path.join(metaDir, `${metaKey}.json`);
  res.setHeader("Content-Type", "application/json");
  if (memoryMeta[metaKey]) return res.json(memoryMeta[metaKey]);
  if (fs.existsSync(metaPath)) return res.sendFile(metaPath);
  res.json({ name: "Loading...", image: `${BASE_URL}/images/loading.png` });
});

// ===== TTL Sweep cleanup =====
setInterval(() => {
  const now = Date.now();

  // Cleanup completedByPayload
  for (const [payloadUuid, entry] of completedByPayload.entries()) {
    if (!entry?.completedAt) continue;
    if (now - entry.completedAt > ORDER_TTL_MS) {
      completedByPayload.delete(payloadUuid);
    }
  }

  // Cleanup ordersByPaymentPayload (only completed & older than TTL)
  for (const [payloadUuid, order] of ordersByPaymentPayload.entries()) {
    if (order?.status !== "completed") continue;
    if (!order?.completedAt) continue;
    if (now - order.completedAt > ORDER_TTL_MS) {
      ordersByPaymentPayload.delete(payloadUuid);
    }
  }

  // Cleanup createOrderCache
  for (const [orderKey, entry] of createOrderCache.entries()) {
    if (!entry?.createdAt) continue;
    if (now - entry.createdAt > CREATE_ORDER_CACHE_MS) {
      createOrderCache.delete(orderKey);
    }
  }

  // Cleanup trustlineStatusCache
  for (const [key, entry] of trustlineStatusCache.entries()) {
    if (!entry?.checkedAt) continue;
    if (now - entry.checkedAt > TRUSTLINE_CACHE_MS) {
      trustlineStatusCache.delete(key);
    }
  }

  // Optional: cleanup txCache to avoid unbounded memory
  const TX_CACHE_TTL = Number(process.env.TX_CACHE_TTL_MS || 30 * 60 * 1000);
  if (TX_CACHE_TTL > 0) {
    for (const [txid, val] of txCache.entries()) {
      const ts = val?.__cachedAt;
      if (ts && now - ts > TX_CACHE_TTL) txCache.delete(txid);
    }
  }
}, SWEEP_INTERVAL_MS);

// Patch: stamp cache time
const _txCacheSet = txCache.set.bind(txCache);
txCache.set = (k, v) => _txCacheSet(k, { ...v, __cachedAt: Date.now() });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 BASE_URL: ${BASE_URL}`);
  console.log(`🏦 STORE_ADDRESS (Destination): ${STORE_ADDRESS}`);
  console.log(`🪙 MPT Issuance: ${KFD_MPT_ISSUANCE_ID}`);
  console.log(`🧹 ORDER_TTL_MS: ${ORDER_TTL_MS} ms, SWEEP_INTERVAL_MS: ${SWEEP_INTERVAL_MS} ms`);
  console.log(`💵 RLUSD currency: ${RLUSD_CURRENCY}, issuer: ${RLUSD_ISSUER || "(not set)"}`);
  console.log(`♻️ CREATE_ORDER_CACHE_MS: ${CREATE_ORDER_CACHE_MS} ms`);
  console.log(`🔗 TRUSTLINE_CACHE_MS: ${TRUSTLINE_CACHE_MS} ms`);
  if (STORE_SECRET) {
    console.log(`🔐 STORE_SECRET present: true`);
  } else {
    console.log(`🔐 STORE_SECRET present: false`);
  }
});