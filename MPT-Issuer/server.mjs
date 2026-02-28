import "dotenv/config"
import express from "express"
import morgan from "morgan"
import Database from "better-sqlite3"
import { Client, Wallet, decodeAccountID } from "xrpl"
import { XummSdk } from "xumm-sdk"

const PORT = Number(process.env.PORT || 3000)
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`
const XRPL_WS = process.env.XRPL_WS
const XUMM_API_KEY = process.env.XUMM_API_KEY
const XUMM_API_SECRET = process.env.XUMM_API_SECRET

if (!XRPL_WS) throw new Error("Missing XRPL_WS")
if (!XUMM_API_KEY || !XUMM_API_SECRET) throw new Error("Missing XUMM_API_KEY / XUMM_API_SECRET")
if (!process.env.KFD_ISSUER_SEED) throw new Error("Missing KFD_ISSUER_SEED")

const issuerWallet = Wallet.fromSeed(process.env.KFD_ISSUER_SEED)
const EXPECT_ISSUER = process.env.KFD_ISSUER_ADDRESS || null
if (EXPECT_ISSUER && EXPECT_ISSUER !== issuerWallet.classicAddress) {
  throw new Error(`KFD_ISSUER_SEED mismatch: seed=${issuerWallet.classicAddress} expected=${EXPECT_ISSUER}`)
}

const xumm = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET)

// --------------------
// SQLite
// --------------------
const db = new Database("./data.sqlite")
db.pragma("journal_mode = WAL")
db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS xumm_payloads (
  uuid TEXT PRIMARY KEY,
  identifier TEXT,
  created_at INTEGER,
  resolved_at INTEGER,
  signed INTEGER,
  cancelled INTEGER,
  expired INTEGER,
  txid TEXT,
  raw_json TEXT
);

-- ✅ Issuance / Audit tables (for console listing)
CREATE TABLE IF NOT EXISTS authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder TEXT NOT NULL,
  issuance_id TEXT NOT NULL,    -- 48-hex
  txid TEXT NOT NULL UNIQUE,
  source TEXT,                  -- API_AUTHORIZE / AUTO_AUTHORIZE / ...
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer TEXT NOT NULL,
  destination TEXT NOT NULL,
  issuance_id TEXT NOT NULL,    -- 48-hex
  value TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE,
  source TEXT,                  -- API_SEND / SWAP_AUTO / ...
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clawbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer TEXT NOT NULL,
  holder TEXT NOT NULL,
  issuance_id TEXT NOT NULL,
  value TEXT,
  txid TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder TEXT NOT NULL,
  issuance_id TEXT NOT NULL,
  locked INTEGER NOT NULL,       -- 1=locked, 0=unlocked
  txid TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_locks_holder_issuance_txid
ON account_locks(txid);

CREATE INDEX IF NOT EXISTS idx_account_locks_holder_issuance
ON account_locks(holder, issuance_id);
CREATE INDEX IF NOT EXISTS idx_authorizations_created_at ON authorizations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clawbacks_created_at ON clawbacks(created_at DESC);
`)

function kvGet(k) {
  const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k)
  return r?.v ?? null
}
function kvSet(k, v) {
  db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v))
}

function kvGetBool(k, defaultValue = false) {
  const v = kvGet(k)
  if (v == null) return defaultValue
  return v === "1" || v === "true" || v === "TRUE"
}

function isBlacklisted(account) {
  return kvGetBool(`BLACKLIST_${account}`, false)
}

function isAutoLockEnabled() {
  return kvGetBool("POLICY_AUTO_LOCK_AFTER_SWAP", false)
}

function isAutoUnlockEnabled() {
  return kvGetBool("POLICY_AUTO_UNLOCK_AFTER_SWAP", false)
}

function isAutoClawbackEnabled() {
  return kvGetBool("POLICY_AUTO_CLAWBACK_BLACKLIST", false)
}

function tryInsertAuthorization({ holder, issuanceId48, txid, source }) {
  if (!txid) return
  try {
    db.prepare(`
      INSERT INTO authorizations(holder, issuance_id, txid, source, created_at)
      VALUES(?,?,?,?,?)
    `).run(holder, issuanceId48, txid, source || null, Date.now())
  } catch (e) {
    // ignore duplicates by txid
    if (!String(e?.message || "").includes("UNIQUE")) throw e
  }
}

function tryInsertTransfer({ issuer, destination, issuanceId48, value, txid, source }) {
  if (!txid) return
  try {
    db.prepare(`
      INSERT INTO transfers(issuer, destination, issuance_id, value, txid, source, created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(issuer, destination, issuanceId48, String(value), txid, source || null, Date.now())
  } catch (e) {
    if (!String(e?.message || "").includes("UNIQUE")) throw e
  }
}
function tryInsertClawback({ issuer, holder, issuanceId48, value, txid, source }) {
  if (!txid) return
  try {
    db.prepare(`
      INSERT INTO clawbacks(issuer, holder, issuance_id, value, txid, source, created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(
      issuer,
      holder,
      issuanceId48,
      value == null ? null : String(value),
      txid,
      source || null,
      Date.now()
    )
  } catch (e) {
    if (!String(e?.message || "").includes("UNIQUE")) throw e
  }
}

function tryInsertLockAction({ holder, issuanceId48, locked, txid, source }) {
  if (!txid) return
  try {
    const now = Date.now()
    db.prepare(`
      INSERT INTO account_locks(holder, issuance_id, locked, txid, source, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(
      holder,
      issuanceId48,
      locked ? 1 : 0,
      txid,
      source || null,
      now,
      now
    )
  } catch (e) {
    if (!String(e?.message || "").includes("UNIQUE")) throw e
  }
}

// --------------------
// Helpers
// --------------------
function calcMptToSendFromPayment(validatedTx) {
  const txj = validatedTx?.tx_json || validatedTx || {}
  const meta = validatedTx?.meta || {}

  let paid = meta.delivered_amount
  if (paid == null) paid = meta.DeliveredAmount
  if (paid == null) paid = txj.DeliverMax ?? txj.SendMax ?? txj.Amount

  // XRP drops
  if (typeof paid === "string") {
    const drops = Number(paid)
    if (!Number.isFinite(drops) || drops <= 0) return 0
    const xrp = drops / 1_000_000
    return Math.floor(xrp * 2) // 1 XRP = 2 MPT
  }

  // IOU (RLUSD)
  if (paid && typeof paid === "object") {
    const cur = String(paid.currency || "").toUpperCase()
    const v = Number(paid.value)
    if (!Number.isFinite(v) || v <= 0) return 0
    if (cur === "RLUSD") return Math.floor(v * 100) // 1 RLUSD = 100 MPT
    return 0
  }

  return 0
}

const app = express()
app.use(morgan("dev"))
app.use(express.json())
app.use(express.static("public"))

// --------------------
// XRPL client
// --------------------
let xrplClient = null
async function getXRPL() {
  if (xrplClient && xrplClient.isConnected()) return xrplClient
  xrplClient = new Client(XRPL_WS)
  await xrplClient.connect()
  return xrplClient
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --------------------
// Validators
// --------------------
function mustHexN(name, v, n) {
  const raw = String(v ?? "")
  const trimmed = raw.trim()
  const re = new RegExp(`^[0-9A-Fa-f]{${n}}$`)
  if (!re.test(trimmed)) {
    const e = new Error(`${name}_INVALID_${n}HEX`)
    e.status = 400
    e.detail = {
      name,
      expected: `${n} hex chars`,
      rawLength: raw.length,
      trimmedLength: trimmed.length,
      rawJSON: JSON.stringify(raw),
      trimmedJSON: JSON.stringify(trimmed),
    }
    throw e
  }
  return trimmed.toUpperCase()
}
function must48hex(name, v) { return mustHexN(name, v, 48) }  // UInt192
function must64hex(name, v) { return mustHexN(name, v, 64) }  // Hash256

function mustRAddress(name, v) {
  const s = String(v ?? "").trim()
  if (!/^r[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) {
    const e = new Error(`${name}_INVALID_R_ADDRESS`)
    e.status = 400
    e.detail = { name, got: s }
    throw e
  }
  return s
}

// MPTokenIssuanceID（UInt192 / 48 hex） = Sequence(4 bytes BE) + AccountID(20 bytes)
function buildMPTokenIssuanceID48(sequence, issuerClassicAddress) {
  const seq = Number(sequence)
  if (!Number.isInteger(seq) || seq <= 0) throw new Error("Invalid sequence for MPTokenIssuanceID")
  const seqBuf = Buffer.alloc(4)
  seqBuf.writeUInt32BE(seq, 0)
  const acctBytes = Buffer.from(decodeAccountID(issuerClassicAddress)) // 20 bytes
  return Buffer.concat([seqBuf, acctBytes]).toString("hex").toUpperCase()
}

// --------------------
// Issuance ledger lookup (use 64-hex LedgerIndex)
// --------------------
async function getActiveIssuanceLedgerNode() {
  const idx = kvGet("KFD_ISSUANCE_INDEX")
  if (!idx) return null
  const issuanceIndex = must64hex("issuanceIndex", idx)

  const client = await getXRPL()
  const r = await client.request({
    command: "ledger_entry",
    index: issuanceIndex,
    ledger_index: "validated",
  })
  return r?.result?.node || null
}

async function assertActiveIssuanceBelongsToServerIssuer() {
  const node = await getActiveIssuanceLedgerNode()
  if (!node) {
    const e = new Error("ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND")
    e.status = 400
    e.detail = { issuanceIndex: kvGet("KFD_ISSUANCE_INDEX") }
    throw e
  }
  const issuer = node?.Issuer
  const serverIssuer = issuerWallet.classicAddress
  if (!issuer || issuer !== serverIssuer) {
    const e = new Error("ISSUANCE_ISSUER_MISMATCH")
    e.status = 400
    e.detail = { issuer, serverIssuer, issuanceIndex: kvGet("KFD_ISSUANCE_INDEX") }
    throw e
  }
  return node
}

async function holderHasMPTokenEntry(holder, issuanceId48) {
  const client = await getXRPL()
  const r = await client.request({
    command: "account_objects",
    account: holder,
    type: "mptoken",
    ledger_index: "validated"
  })
  const objs = r?.result?.account_objects || []
  return objs.some(o => String(o?.MPTokenIssuanceID || "").toUpperCase() === issuanceId48)
}

async function createHolderOptInPayload(holder, issuanceId48) {
  const txjson = {
    TransactionType: "MPTokenAuthorize",
    Account: holder,
    MPTokenIssuanceID: issuanceId48
  }
  return await createXummPayload({ txjson, identifier: "HOLDER_OPTIN" })
}

async function getActiveIssuanceFlags() {
  const node = await getActiveIssuanceLedgerNode()
  if (!node) return null

  const flags = Number(node?.Flags || 0)
  return {
    flags,
    tfMPTCanLock:     (flags & 0x0002) !== 0,
    tfMPTRequireAuth: (flags & 0x0004) !== 0,
    tfMPTCanClawback: (flags & 0x0040) !== 0,
  }
}

// --------------------
// XRPL submit as issuer (seed)
// --------------------
async function submitAsIssuer(txjson) {
  const client = await getXRPL()
  const tx = { ...txjson, Account: issuerWallet.classicAddress }
  const prepared = await client.autofill(tx)
  const signed = issuerWallet.sign(prepared)
  const result = await client.submitAndWait(signed.tx_blob)

  const tr = result?.result?.meta?.TransactionResult || result?.result?.meta?.transaction_result || null
  const ok = result?.result?.validated && tr === "tesSUCCESS"
  return { ok, txid: result?.result?.hash || null, engineResult: tr, result }
}

async function waitTxValidated(txid, tries = 20, delay = 1200) {
  const client = await getXRPL()
  for (let i = 0; i < tries; i++) {
    try {
      const r = await client.request({ command: "tx", transaction: txid })
      if (r?.result?.validated) return r.result
    } catch {}
    await sleep(delay)
  }
  return null
}

// 64-hex LedgerIndex from tx meta CreatedNode(MPTokenIssuance)
function extractIssuanceIndexFromTxMeta(validatedTx) {
  const nodes = validatedTx?.meta?.AffectedNodes || []
  const created = nodes.map(n => n.CreatedNode).find(c => c && c.LedgerEntryType === "MPTokenIssuance")
  return created?.LedgerIndex || null
}

// --------------------
// Xumm payload (swap)
// --------------------
function savePayload(uuid, identifier, raw) {
  db.prepare(`
    INSERT INTO xumm_payloads(uuid, identifier, created_at, raw_json)
    VALUES(?,?,?,?)
    ON CONFLICT(uuid) DO UPDATE SET raw_json=excluded.raw_json
  `).run(uuid, identifier || null, Date.now(), JSON.stringify(raw))
}
function markPayload(uuid, { signed, cancelled, expired, txid, raw }) {
  db.prepare(`
    UPDATE xumm_payloads
    SET resolved_at=?, signed=?, cancelled=?, expired=?, txid=?, raw_json=?
    WHERE uuid=?
  `).run(Date.now(), signed ? 1 : 0, cancelled ? 1 : 0, expired ? 1 : 0, txid || null, JSON.stringify(raw), uuid)
}

async function createXummPayload({ txjson, identifier }) {
  const payload = await xumm.payload.create({
    txjson,
    options: { submit: true, return_url: { app: "xumm://close", web: `${BASE_URL}/index.html` } },
    custom_meta: { identifier },
  })
  savePayload(payload.uuid, identifier, payload)
  return { uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next?.always || null }
}

// --------------------
// Core issuer actions
// --------------------
function getActiveIssuanceId48OrThrow(inputMaybe48) {
  const id = inputMaybe48 || kvGet("KFD_ISSUANCE_ID")
  if (!id) {
    const e = new Error("MISSING_KFD_ISSUANCE_ID")
    e.status = 400
    e.detail = { note: "Create issuance first, and use returned issuanceId (48-hex UInt192)." }
    throw e
  }
  const trimmed = String(id).trim()
  if (/^[0-9A-Fa-f]{64}$/.test(trimmed)) {
    const e = new Error("ISSUANCE_ID_SHOULD_BE_48HEX_NOT_64HEX")
    e.status = 400
    e.detail = { gotLength: 64, note: "Use issuanceId(48 hex) from /api/kfd/create response, not issuanceIndex(64 hex)." }
    throw e
  }
  return must48hex("issuanceId", id)
}

async function issuerAuthorizeHolder(issuanceId48, holder) {
  await assertActiveIssuanceBelongsToServerIssuer()
  const txjson = {
    TransactionType: "MPTokenAuthorize",
    MPTokenIssuanceID: issuanceId48,
    Holder: holder,
    Flags: 0,
  }
  return await submitAsIssuer(txjson)
}

async function issuerSendMPT(issuanceId48, destination, value) {
  await assertActiveIssuanceBelongsToServerIssuer()
  const txjson = {
    TransactionType: "Payment",
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId48, value: String(value) },
  }
  return await submitAsIssuer(txjson)
}
async function issuerClawbackMPT(issuanceId48, holder, value) {
  await assertActiveIssuanceBelongsToServerIssuer()

  const txjson = {
    TransactionType: "Clawback",
    Holder: holder,
    Amount: {
      mpt_issuance_id: issuanceId48,
      value: String(value)
    }
  }

  return await submitAsIssuer(txjson)
}

async function issuerLockHolder(issuanceId48, holder) {
  await assertActiveIssuanceBelongsToServerIssuer()

  const txjson = {
    TransactionType: "MPTokenIssuanceSet",
    MPTokenIssuanceID: issuanceId48,
    Holder: holder,
    Flags: 1 // tfMPTLock
  }

  return await submitAsIssuer(txjson)
}

async function issuerUnlockHolder(issuanceId48, holder) {
  await assertActiveIssuanceBelongsToServerIssuer()

  const txjson = {
    TransactionType: "MPTokenIssuanceSet",
    MPTokenIssuanceID: issuanceId48,
    Holder: holder,
    Flags: 2 // tfMPTUnlock
  }

  return await submitAsIssuer(txjson)
}

// --------------------
// API
// --------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), serverIssuer: issuerWallet.classicAddress })
})

app.get("/api/kfd/state", (req, res) => {
  res.json({
    serverIssuer: issuerWallet.classicAddress,
    issuanceId: kvGet("KFD_ISSUANCE_ID"),
    issuanceIndex: kvGet("KFD_ISSUANCE_INDEX"),
    issuanceCreatedAt: kvGet("KFD_ISSUANCE_CREATED_AT") || null,
  })
})

// 1) Create issuance (auto)
app.post("/api/kfd/create", async (req, res) => {
  try {
    const {
      assetScale = 0,
      maxAmount = "1000000000",
      transferFee = 0,
      ticker = "KFD",
      name = "KFD Token",
      description = "KFD MPT",
    } = req.body || {}

    const metaHex = Buffer.from(JSON.stringify({ ticker, name, description }), "utf8")
      .toString("hex")
      .toUpperCase()

    const txjson = {
      TransactionType: "MPTokenIssuanceCreate",
      AssetScale: Number(assetScale),
      TransferFee: Number(transferFee),
      MaximumAmount: String(maxAmount),
      MPTokenMetadata: metaHex,
      Flags: 118,
    }

    const out = await submitAsIssuer(txjson)
    if (!out.ok) return res.status(400).json({ error: `create failed: ${out.engineResult}`, detail: out.result })

    const validatedTx = await waitTxValidated(out.txid)
    if (!validatedTx) {
      return res.json({
        mode: "auto",
        txid: out.txid,
        engineResult: out.engineResult,
        issuanceId: null,
        issuanceIndex: null,
        note: "TX not validated yet.",
      })
    }

    const issuanceIndex = extractIssuanceIndexFromTxMeta(validatedTx)
    if (!issuanceIndex) {
      return res.json({
        mode: "auto",
        txid: out.txid,
        engineResult: out.engineResult,
        issuanceId: null,
        issuanceIndex: null,
        note: "Validated but cannot extract issuanceIndex(64) from meta.",
      })
    }

    const seq = validatedTx?.tx_json?.Sequence
    if (!seq) {
      return res.json({
        mode: "auto",
        txid: out.txid,
        engineResult: out.engineResult,
        issuanceId: null,
        issuanceIndex,
        note: "Validated but cannot read tx_json.Sequence to build issuanceId(48).",
      })
    }

    const issuanceId = buildMPTokenIssuanceID48(seq, issuerWallet.classicAddress)

    kvSet("KFD_ISSUANCE_ID", issuanceId)
    kvSet("KFD_ISSUANCE_INDEX", issuanceIndex)
    kvSet("KFD_ISSUANCE_CREATED_AT", Date.now())
    kvSet("KFD_ASSET_SCALE", Number(assetScale))
    kvSet("KFD_MAX_AMOUNT", String(maxAmount))
    kvSet("KFD_TRANSFER_FEE", Number(transferFee))
    kvSet("KFD_SYMBOL", ticker)

    res.json({
      mode: "auto",
      txid: out.txid,
      engineResult: out.engineResult,
      issuanceId,
      issuanceIndex,
    })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

// 2) Authorize holder (auto)
app.post("/api/kfd/authorize", async (req, res) => {
  try {
    const issuanceId48 = getActiveIssuanceId48OrThrow(req.body?.issuanceId)
    const holder = mustRAddress("holder", req.body?.holder)

    // holder opt-in required
    const has = await holderHasMPTokenEntry(holder, issuanceId48)
    if (!has) {
      const payload = await createHolderOptInPayload(holder, issuanceId48)
      return res.status(409).json({
        error: "HOLDER_NOT_OPTED_IN",
        message: "Holder must opt-in first (create MPToken entry) before issuer can approve.",
        authorizePayload: payload
      })
    }

    const out = await submitAsIssuer({
      TransactionType: "MPTokenAuthorize",
      MPTokenIssuanceID: issuanceId48,
      Holder: holder,
      Flags: 0
    })

    if (!out.ok) return res.status(400).json({ error: `authorize failed: ${out.engineResult}`, detail: out.result })

    // ✅ persist record
    tryInsertAuthorization({ holder, issuanceId48, txid: out.txid, source: "API_AUTHORIZE" })

    res.json({ mode: "auto", txid: out.txid, engineResult: out.engineResult })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

// 3) Send MPT (auto)
app.post("/api/kfd/send", async (req, res) => {
  try {
    const issuanceId48 = getActiveIssuanceId48OrThrow(req.body?.issuanceId)
    const destination = mustRAddress("destination", req.body?.destination)

    const value = String(req.body?.value ?? "").trim()
    if (!value || !/^\d+(\.\d+)?$/.test(value)) {
      return res.status(400).json({ error: "value required (number-like string)" })
    }

    const flags = await getActiveIssuanceFlags()
    if (!flags) return res.status(400).json({ error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND" })

    // RequireAuth: pre-authorize
    if (flags.tfMPTRequireAuth) {
      const auth = await issuerAuthorizeHolder(issuanceId48, destination)
      if (!auth.ok) return res.status(400).json({ error: `pre-authorize failed: ${auth.engineResult}`, detail: auth.result })
      tryInsertAuthorization({ holder: destination, issuanceId48, txid: auth.txid, source: "AUTO_AUTHORIZE_SEND" })
    }

    const out = await issuerSendMPT(issuanceId48, destination, value)
    if (!out.ok) return res.status(400).json({ error: `send failed: ${out.engineResult}`, detail: out.result })

    // ✅ persist record
    tryInsertTransfer({
      issuer: issuerWallet.classicAddress,
      destination,
      issuanceId48,
      value,
      txid: out.txid,
      source: "API_SEND"
    })

    res.json({ mode: "auto", txid: out.txid, engineResult: out.engineResult })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

// 5) swap-init: user pays XRP/RLUSD to issuer via Xumm
app.post("/api/kfd/swap-init", async (req, res) => {
  try {
    const currency = String(req.body?.currency || "").toUpperCase()
    const amount = Number(req.body?.amount)

    if (!["XRP", "RLUSD"].includes(currency)) return res.status(400).json({ error: "currency must be XRP or RLUSD" })
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" })

    const issuer = issuerWallet.classicAddress

    let deliverAmount
    if (currency === "XRP") {
      deliverAmount = String(Math.floor(amount * 1_000_000))
      if (deliverAmount === "0") return res.status(400).json({ error: "amount too small (drops=0)" })
    } else {
      const rlusdIssuer = process.env.RLUSD_ISSUER
      if (!rlusdIssuer) return res.status(400).json({ error: "Missing RLUSD_ISSUER in .env" })
      deliverAmount = { currency: "RLUSD", issuer: rlusdIssuer, value: String(amount) }
    }

    const txjson = {
      TransactionType: "Payment",
      Destination: issuer,
      Amount: deliverAmount,
      Memos: [{ Memo: { MemoData: Buffer.from("MPT_SWAP", "utf8").toString("hex").toUpperCase() } }],
    }

    const out = await createXummPayload({ txjson, identifier: `SWAP_${currency}` })
    res.json(out)
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
})

// poll payload: once payment validated, auto issue MPT (authorize + payment) with idempotency
app.get("/api/payload/:uuid", async (req, res) => {
  try {
    const uuid = req.params.uuid
    const p = await xumm.payload.get(uuid)

    const resolved = !!p?.meta?.resolved
    const signed = !!p?.meta?.signed
    const cancelled = !!p?.meta?.cancelled
    const expired = !!p?.meta?.expired
    const txid = p?.response?.txid || null

    if (resolved) {
      markPayload(uuid, { signed, cancelled, expired, txid, raw: p })
    }

    let validatedTx = null
    let auto = null

    if (signed && txid) {
      validatedTx = await waitTxValidated(txid)

      if (validatedTx?.validated) {
        let issuanceId48
        let flags

        try {
          issuanceId48 = getActiveIssuanceId48OrThrow(null)
          flags = await getActiveIssuanceFlags()
        } catch (e) {
          auto = {
            ok: false,
            stage: "bootstrap",
            error: e?.message || "ISSUANCE_NOT_READY",
            detail: e?.detail || null
          }
        }

        if (!auto) {
          if (!flags) {
            auto = {
              ok: false,
              stage: "bootstrap",
              error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND"
            }
          } else {
            const txj = validatedTx?.tx_json || validatedTx || {}
            const payer = txj?.Account

            if (!payer) {
              auto = {
                ok: false,
                stage: "read-payer",
                error: "Cannot read payer Account from tx"
              }
            } else {
              const policy = {
                autoLockAfterSwap: isAutoLockEnabled(),
                autoUnlockAfterSwap: isAutoUnlockEnabled(),
                autoClawbackBlacklist: isAutoClawbackEnabled(),
                blacklisted: isBlacklisted(payer),
              }

              const actions = {
                authorize: null,
                issue: null,
                clawback: null,
                lock: null,
                unlock: null,
              }

              // 防重複：主流程 (issue)
              const doneKey = `SWAP_DONE_${uuid}`
              const alreadyIssuedTxid = kvGet(doneKey)

              // ----------------------------
              // (A) RequireAuth: allow-list payer
              // ----------------------------
              if (flags.tfMPTRequireAuth) {
                const authDoneKey = `SWAP_AUTH_DONE_${uuid}`
                const authAlready = kvGet(authDoneKey)

                if (authAlready) {
                  actions.authorize = {
                    ok: true,
                    already: true,
                    txid: authAlready
                  }
                } else {
                  const auth = await issuerAuthorizeHolder(issuanceId48, payer)
                  if (!auth.ok) {
                    auto = {
                      ok: false,
                      stage: "authorize",
                      error: `AUTO_AUTHORIZE_FAILED:${auth.engineResult}`,
                      detail: auth.result,
                      payer,
                      policy,
                      actions
                    }
                  } else {
                    kvSet(authDoneKey, auth.txid)
                    tryInsertAuthorization({
                      holder: payer,
                      issuanceId48,
                      txid: auth.txid,
                      source: "AUTO_AUTHORIZE_SWAP"
                    })
                    actions.authorize = {
                      ok: true,
                      txid: auth.txid
                    }
                  }
                }
              } else {
                actions.authorize = {
                  ok: true,
                  skipped: true,
                  reason: "REQUIRE_AUTH_DISABLED"
                }
              }

              // ----------------------------
              // (B) calc MPT
              // ----------------------------
              let mptToSend = null

              if (!auto) {
                mptToSend = calcMptToSendFromPayment(validatedTx)

                if (!Number.isFinite(mptToSend) || mptToSend <= 0) {
                  auto = {
                    ok: false,
                    stage: "calc",
                    error: "Calculated MPT <= 0",
                    payer,
                    policy,
                    actions,
                    debug: {
                      delivered_amount: validatedTx?.meta?.delivered_amount ?? null,
                      DeliveredAmount: validatedTx?.meta?.DeliveredAmount ?? null,
                      DeliverMax: txj?.DeliverMax ?? null,
                      SendMax: txj?.SendMax ?? null,
                      Amount: txj?.Amount ?? null
                    }
                  }
                }
              }

              // ----------------------------
              // (C) issue MPT to payer
              // ----------------------------
              if (!auto) {
                if (alreadyIssuedTxid) {
                  actions.issue = {
                    ok: true,
                    already: true,
                    txid: alreadyIssuedTxid,
                    value: String(mptToSend)
                  }
                } else {
                  const issue = await issuerSendMPT(issuanceId48, payer, String(mptToSend))
                  if (!issue.ok) {
                    auto = {
                      ok: false,
                      stage: "issue",
                      error: `AUTO_ISSUE_FAILED:${issue.engineResult}`,
                      detail: issue.result,
                      payer,
                      policy,
                      actions
                    }
                  } else {
                    kvSet(doneKey, issue.txid)
                    tryInsertTransfer({
                      issuer: issuerWallet.classicAddress,
                      destination: payer,
                      issuanceId48,
                      value: String(mptToSend),
                      txid: issue.txid,
                      source: "SWAP_AUTO"
                    })
                    actions.issue = {
                      ok: true,
                      txid: issue.txid,
                      value: String(mptToSend)
                    }
                  }
                }
              }

              // ----------------------------
              // (D1) blacklisted => auto clawback
              // 優先度最高
              // ----------------------------
              if (!auto && policy.autoClawbackBlacklist && policy.blacklisted) {
                if (!flags.tfMPTCanClawback) {
                  actions.clawback = {
                    ok: false,
                    skipped: true,
                    reason: "MPT_CLAWBACK_NOT_ENABLED"
                  }
                } else {
                  const clawbackDoneKey = `SWAP_CLAWBACK_DONE_${uuid}`
                  const clawbackAlready = kvGet(clawbackDoneKey)

                  if (clawbackAlready) {
                    actions.clawback = {
                      ok: true,
                      already: true,
                      txid: clawbackAlready,
                      value: String(mptToSend)
                    }
                  } else {
                    const claw = await issuerClawbackMPT(issuanceId48, payer, String(mptToSend))
                    if (!claw.ok) {
                      actions.clawback = {
                        ok: false,
                        error: `AUTO_CLAWBACK_FAILED:${claw.engineResult}`,
                        detail: claw.result
                      }
                    } else {
                      kvSet(clawbackDoneKey, claw.txid)
                      tryInsertClawback({
                        issuer: issuerWallet.classicAddress,
                        holder: payer,
                        issuanceId48,
                        value: String(mptToSend),
                        txid: claw.txid,
                        source: "AUTO_CLAWBACK_SWAP_BLACKLIST"
                      })
                      actions.clawback = {
                        ok: true,
                        txid: claw.txid,
                        value: String(mptToSend)
                      }
                    }
                  }
                }
              } else if (!auto) {
                actions.clawback = {
                  ok: true,
                  skipped: true,
                  reason: policy.blacklisted
                    ? "AUTO_CLAWBACK_POLICY_DISABLED"
                    : "NOT_BLACKLISTED"
                }
              }

              // ----------------------------
              // (D2) auto lock after swap
              // 若 clawback 成功，就不再 lock
              // ----------------------------
              if (!auto && policy.autoLockAfterSwap && !(actions.clawback?.ok === true && !actions.clawback?.skipped)) {
                if (!flags.tfMPTCanLock) {
                  actions.lock = {
                    ok: false,
                    skipped: true,
                    reason: "MPT_LOCK_NOT_ENABLED"
                  }
                } else {
                  const lockDoneKey = `SWAP_LOCK_DONE_${uuid}`
                  const lockAlready = kvGet(lockDoneKey)

                  if (lockAlready) {
                    actions.lock = {
                      ok: true,
                      already: true,
                      txid: lockAlready
                    }
                  } else {
                    const lock = await issuerLockHolder(issuanceId48, payer)
                    if (!lock.ok) {
                      actions.lock = {
                        ok: false,
                        error: `AUTO_LOCK_FAILED:${lock.engineResult}`,
                        detail: lock.result
                      }
                    } else {
                      kvSet(lockDoneKey, lock.txid)
                      tryInsertLockAction({
                        holder: payer,
                        issuanceId48,
                        locked: true,
                        txid: lock.txid,
                        source: "AUTO_LOCK_AFTER_SWAP"
                      })
                      actions.lock = {
                        ok: true,
                        txid: lock.txid
                      }
                    }
                  }
                }
              } else if (!auto) {
                actions.lock = {
                  ok: true,
                  skipped: true,
                  reason: policy.autoLockAfterSwap
                    ? "SKIPPED_AFTER_SUCCESSFUL_CLAWBACK"
                    : "AUTO_LOCK_POLICY_DISABLED"
                }
              }

              // ----------------------------
              // (D3) auto unlock after swap
              // lock 和 unlock 不要同時啟用
              // 若 clawback 成功，也不需 unlock
              // ----------------------------
              if (
                !auto &&
                policy.autoUnlockAfterSwap &&
                !policy.autoLockAfterSwap &&
                !(actions.clawback?.ok === true && !actions.clawback?.skipped)
              ) {
                if (!flags.tfMPTCanLock) {
                  actions.unlock = {
                    ok: false,
                    skipped: true,
                    reason: "MPT_LOCK_NOT_ENABLED"
                  }
                } else {
                  const unlockDoneKey = `SWAP_UNLOCK_DONE_${uuid}`
                  const unlockAlready = kvGet(unlockDoneKey)

                  if (unlockAlready) {
                    actions.unlock = {
                      ok: true,
                      already: true,
                      txid: unlockAlready
                    }
                  } else {
                    const unlock = await issuerUnlockHolder(issuanceId48, payer)
                    if (!unlock.ok) {
                      actions.unlock = {
                        ok: false,
                        error: `AUTO_UNLOCK_FAILED:${unlock.engineResult}`,
                        detail: unlock.result
                      }
                    } else {
                      kvSet(unlockDoneKey, unlock.txid)
                      tryInsertLockAction({
                        holder: payer,
                        issuanceId48,
                        locked: false,
                        txid: unlock.txid,
                        source: "AUTO_UNLOCK_AFTER_SWAP"
                      })
                      actions.unlock = {
                        ok: true,
                        txid: unlock.txid
                      }
                    }
                  }
                }
              } else if (!auto) {
                actions.unlock = {
                  ok: true,
                  skipped: true,
                  reason: policy.autoUnlockAfterSwap
                    ? (policy.autoLockAfterSwap
                        ? "AUTO_UNLOCK_DISABLED_BECAUSE_AUTO_LOCK_ENABLED"
                        : "SKIPPED_AFTER_SUCCESSFUL_CLAWBACK")
                    : "AUTO_UNLOCK_POLICY_DISABLED"
                }
              }

              // ----------------------------
              // Final auto result
              // ----------------------------
              if (!auto) {
                auto = {
                  ok: true,
                  payer,
                  issuedTxid: actions.issue?.txid || alreadyIssuedTxid || null,
                  mptToSend: String(mptToSend),
                  policy,
                  actions
                }
              }
            }
          }
        }
      }
    }

    res.json({
      uuid,
      resolved,
      signed,
      cancelled,
      expired,
      txid,
      validatedTx,
      auto
    })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

app.post("/api/kfd/clawback", async (req, res) => {
  try {
    const issuanceId48 = getActiveIssuanceId48OrThrow(req.body?.issuanceId)
    const holder = mustRAddress("holder", req.body?.holder)

    const value = String(req.body?.value ?? "").trim()
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return res.status(400).json({
        error: "value required (positive integer string for MPT raw units)"
      })
    }

    const flags = await getActiveIssuanceFlags()
    if (!flags) return res.status(400).json({ error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND" })
    if (!flags.tfMPTCanClawback) {
      return res.status(400).json({ error: "MPT_CLAWBACK_NOT_ENABLED" })
    }

    const out = await issuerClawbackMPT(issuanceId48, holder, value)
    if (!out.ok) {
      return res.status(400).json({
        error: `clawback failed: ${out.engineResult}`,
        detail: out.result
      })
    }

    tryInsertClawback({
      issuer: issuerWallet.classicAddress,
      holder,
      issuanceId48,
      value,
      txid: out.txid,
      source: "API_CLAWBACK"
    })

    res.json({
      mode: "auto",
      txid: out.txid,
      engineResult: out.engineResult
    })
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      detail: e.detail
    })
  }
})

app.post("/api/kfd/lock", async (req, res) => {
  try {
    const issuanceId48 = getActiveIssuanceId48OrThrow(req.body?.issuanceId)
    const holder = mustRAddress("holder", req.body?.holder)

    const flags = await getActiveIssuanceFlags()
    if (!flags) return res.status(400).json({ error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND" })
    if (!flags.tfMPTCanLock) {
      return res.status(400).json({ error: "MPT_LOCK_NOT_ENABLED" })
    }

    const out = await issuerLockHolder(issuanceId48, holder)
    if (!out.ok) {
      return res.status(400).json({
        error: `lock failed: ${out.engineResult}`,
        detail: out.result
      })
    }

    tryInsertLockAction({
      holder,
      issuanceId48,
      locked: true,
      txid: out.txid,
      source: "API_LOCK"
    })

    res.json({
      mode: "auto",
      txid: out.txid,
      engineResult: out.engineResult
    })
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      detail: e.detail
    })
  }
})

app.post("/api/kfd/unlock", async (req, res) => {
  try {
    const issuanceId48 = getActiveIssuanceId48OrThrow(req.body?.issuanceId)
    const holder = mustRAddress("holder", req.body?.holder)

    const flags = await getActiveIssuanceFlags()
    if (!flags) return res.status(400).json({ error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND" })
    if (!flags.tfMPTCanLock) {
      return res.status(400).json({ error: "MPT_LOCK_NOT_ENABLED" })
    }

    const out = await issuerUnlockHolder(issuanceId48, holder)
    if (!out.ok) {
      return res.status(400).json({
        error: `unlock failed: ${out.engineResult}`,
        detail: out.result
      })
    }

    tryInsertLockAction({
      holder,
      issuanceId48,
      locked: false,
      txid: out.txid,
      source: "API_UNLOCK"
    })

    res.json({
      mode: "auto",
      txid: out.txid,
      engineResult: out.engineResult
    })
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      detail: e.detail
    })
  }
})

app.get("/api/kfd/policy", (req, res) => {
  res.json({
    autoLockAfterSwap: isAutoLockEnabled(),
    autoUnlockAfterSwap: isAutoUnlockEnabled(),
    autoClawbackBlacklist: isAutoClawbackEnabled(),
  })
})

app.post("/api/kfd/policy", (req, res) => {
  const body = req.body || {}

  if (body.autoLockAfterSwap !== undefined) {
    kvSet("POLICY_AUTO_LOCK_AFTER_SWAP", body.autoLockAfterSwap ? "1" : "0")
  }
  if (body.autoUnlockAfterSwap !== undefined) {
    kvSet("POLICY_AUTO_UNLOCK_AFTER_SWAP", body.autoUnlockAfterSwap ? "1" : "0")
  }
  if (body.autoClawbackBlacklist !== undefined) {
    kvSet("POLICY_AUTO_CLAWBACK_BLACKLIST", body.autoClawbackBlacklist ? "1" : "0")
  }

  res.json({
    ok: true,
    autoLockAfterSwap: isAutoLockEnabled(),
    autoUnlockAfterSwap: isAutoUnlockEnabled(),
    autoClawbackBlacklist: isAutoClawbackEnabled(),
  })
})

app.post("/api/kfd/blacklist/add", (req, res) => {
  try {
    const holder = mustRAddress("holder", req.body?.holder)
    kvSet(`BLACKLIST_${holder}`, "1")
    res.json({ ok: true, holder, blacklisted: true })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

app.post("/api/kfd/blacklist/remove", (req, res) => {
  try {
    const holder = mustRAddress("holder", req.body?.holder)
    kvSet(`BLACKLIST_${holder}`, "0")
    res.json({ ok: true, holder, blacklisted: false })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

app.get("/api/kfd/blacklist/:holder", (req, res) => {
  try {
    const holder = mustRAddress("holder", req.params.holder)
    res.json({ holder, blacklisted: isBlacklisted(holder) })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

// --------------------
// MPT query endpoints (issuance + account)
// --------------------
function formatScaled(rawStr, scale) {
  const raw = (rawStr ?? "0").toString()
  const s = Number(scale || 0)
  if (s <= 0) return raw

  const neg = raw.startsWith("-")
  const digits = neg ? raw.slice(1) : raw
  const pad = digits.padStart(s + 1, "0")
  const intPart = pad.slice(0, -s)
  const fracPart = pad.slice(-s).replace(/0+$/, "")
  const out = fracPart ? `${intPart}.${fracPart}` : intPart
  return neg ? `-${out}` : out
}

// Chain: issuance summary (kv + on-chain)
app.get("/api/mpt/issuance", async (req, res) => {
  try {
    const issuanceId = (kvGet("KFD_ISSUANCE_ID") || "").toUpperCase() || null
    const issuanceIndex = (kvGet("KFD_ISSUANCE_INDEX") || "").toUpperCase() || null

    if (!issuanceId && !issuanceIndex) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_KFD_ISSUANCE_ID",
        detail: { note: "Create issuance first so server can persist issuanceId / issuanceIndex into sqlite (kv table)." }
      })
    }

    // prefer index
    let node = null
    let ledgerIndex = null
    if (issuanceIndex) {
      try { node = await getActiveIssuanceLedgerNode() } catch {}
    }
    if (!node && issuanceId) {
      const client = await getXRPL()
      const r = await client.request({
        command: "ledger_entry",
        mpt_issuance: issuanceId,
        ledger_index: "validated",
      })
      node = r?.result?.node || null
      ledgerIndex = r?.result?.ledger_index ?? null
    }
    if (!node) {
      return res.status(404).json({
        ok: false,
        error: "MPTokenIssuance not found onchain",
        issuanceId,
        issuanceIndex,
      })
    }

    // sanity issuer
    const issuerOnLedger = (node.Issuer || "").trim()
    if (issuerOnLedger && issuerOnLedger !== issuerWallet.classicAddress) {
      return res.status(400).json({
        ok: false,
        error: "Issuer mismatch (wrong issuance id/index or wrong server seed)",
        expected_issuer: issuerWallet.classicAddress,
        ledger_issuer: issuerOnLedger,
        issuanceId,
        issuanceIndex,
      })
    }

    const assetScale = Number(node.AssetScale ?? 0)
    const outRaw = (node.OutstandingAmount ?? "0").toString()
    const maxRaw = (node.MaximumAmount ?? "0").toString()

    res.json({
      ok: true,
      network: XRPL_WS,
      config: {
        serverIssuer: issuerWallet.classicAddress,
        issuanceId,
        issuanceIndex,
        issuanceCreatedAt: kvGet("KFD_ISSUANCE_CREATED_AT") || null,
      },
      onchain: {
        ledger_entry_type: node.LedgerEntryType,
        flags: node.Flags ?? 0,
        transfer_fee: node.TransferFee ?? 0,
        asset_scale: assetScale,
        outstanding_amount_raw: outRaw,
        maximum_amount_raw: maxRaw,
        outstanding_amount_scaled: formatScaled(outRaw, assetScale),
        maximum_amount_scaled: formatScaled(maxRaw, assetScale),
      },
      validated_ledger_index: ledgerIndex,
    })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e?.message || String(e), detail: e.detail })
  }
})

// Chain: account MPT balance for active issuance
app.get("/api/mpt/account", async (req, res) => {
  try {
    const account = String(req.query.account || "").trim()
    if (!account) return res.status(400).json({ ok: false, error: "Missing account (query ?account=...)" })

    const issuanceId = (kvGet("KFD_ISSUANCE_ID") || "").toUpperCase()
    if (!issuanceId) return res.status(400).json({ ok: false, error: "MISSING_KFD_ISSUANCE_ID" })

    const client = await getXRPL()
    const r = await client.request({
      command: "account_objects",
      account,
      ledger_index: "validated",
      type: "mptoken",
    })
    const objs = r?.result?.account_objects || []
    const mpt = objs.find((o) => String(o.MPTokenIssuanceID || "").toUpperCase() === issuanceId)

    const balRaw = (mpt?.Balance ?? mpt?.balance ?? mpt?.Amount ?? mpt?.amount ?? "0").toString()

    let node = null
    try { node = await getActiveIssuanceLedgerNode() } catch {}
    let assetScale = Number(node?.AssetScale ?? 0)

    if (!node) {
      const le = await client.request({
        command: "ledger_entry",
        mpt_issuance: issuanceId,
        ledger_index: "validated",
      })
      assetScale = Number(le?.result?.node?.AssetScale ?? 0)
    }

    res.json({
      ok: true,
      network: XRPL_WS,
      account,
      issuance_id: issuanceId,
      balance_raw: balRaw,
      balance_scaled: formatScaled(balRaw, assetScale),
      asset_scale: assetScale,
      has_mptoken_object: !!mpt,
    })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e?.message || String(e), detail: e.detail })
  }
})

app.get("/api/check-mpt", async (req, res) => {
  try {
    const node = await getActiveIssuanceLedgerNode()
    if (!node) return res.status(400).json({ error: "ISSUANCE_INDEX_NOT_SET_OR_NOT_FOUND" })

    const flags = Number(node?.Flags || 0)
    res.json({
      issuanceId: kvGet("KFD_ISSUANCE_ID"),
      issuanceIndex: kvGet("KFD_ISSUANCE_INDEX"),
      issuer: node?.Issuer || null,
      serverIssuer: issuerWallet.classicAddress,
      flags,
      details: {
        tfMPTRequireAuth: (flags & 0x0004) !== 0,
        tfMPTCanClawback: (flags & 0x0040) !== 0,
      },
    })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), detail: e.detail })
  }
})

// --------------------
// ✅ Monitor (DB-driven)
// --------------------
app.get("/api/monitor", (req, res) => {
  try {
    const issuanceId = kvGet("KFD_ISSUANCE_ID")
    const issuanceIndex = kvGet("KFD_ISSUANCE_INDEX")

    const payloads = db
      .prepare("SELECT * FROM xumm_payloads ORDER BY created_at DESC LIMIT 50")
      .all()

    const authorizations = db
      .prepare("SELECT * FROM authorizations ORDER BY created_at DESC LIMIT 50")
      .all()

    const transfers = db
      .prepare("SELECT * FROM transfers ORDER BY created_at DESC LIMIT 50")
      .all()

    const clawbacks = db
      .prepare("SELECT * FROM clawbacks ORDER BY created_at DESC LIMIT 50")
      .all()
    
    const locks = db
      .prepare("SELECT * FROM account_locks ORDER BY created_at DESC LIMIT 50")
      .all()

    const counts = {
      issuances: issuanceId ? 1 : 0,
      authorizations: db.prepare("SELECT COUNT(*) AS c FROM authorizations").get().c,
      transfers: db.prepare("SELECT COUNT(*) AS c FROM transfers").get().c,
      clawbacks: db.prepare("SELECT COUNT(*) AS c FROM clawbacks").get().c,
      locks: db.prepare("SELECT COUNT(*) AS c FROM account_locks").get().c,
    }

    const issuances = issuanceId
      ? [{
          id: 1,
          symbol: kvGet("KFD_SYMBOL") || "KFD",
          issuer_account: issuerWallet.classicAddress,
          issuance_id: issuanceId,
          issuance_index: issuanceIndex,
          max_amount: kvGet("KFD_MAX_AMOUNT") || null,
          transfer_fee: Number(kvGet("KFD_TRANSFER_FEE") || 0),
          asset_scale: Number(kvGet("KFD_ASSET_SCALE") || 0),
          created_at: Number(kvGet("KFD_ISSUANCE_CREATED_AT") || 0) || Date.now(),
        }]
      : null

    res.json({
      serverTime: Date.now(),
      issuances,
      authorizations,
      transfers,
      clawbacks,
      payloads,
      counts,
      locks,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) })
  }
})
app.get("/api/debug/db", (req, res) => {
  res.json({
    cwd: process.cwd(),
    db_file: "./data.sqlite",
  })
})

app.get("/api/kfd/account-status/:holder", async (req, res) => {
  try {
    const holder = mustRAddress("holder", req.params.holder)
    const issuanceId48 = getActiveIssuanceId48OrThrow(null)

    const latestLock = db.prepare(`
      SELECT *
      FROM account_locks
      WHERE holder = ? AND issuance_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(holder, issuanceId48)

    const latestClawback = db.prepare(`
      SELECT *
      FROM clawbacks
      WHERE holder = ? AND issuance_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(holder, issuanceId48)

    const hasMPT = await holderHasMPTokenEntry(holder, issuanceId48)

    res.json({
      holder,
      issuanceId: issuanceId48,
      hasMPT,
      latestLock: latestLock || null,
      clawbacks: latestClawback
    })
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      detail: e.detail
    })
  }
})

app.get("/api/kfd/account-actions", (req, res) => {
  try {
    const locks = db.prepare(`
      SELECT * FROM account_locks
      ORDER BY created_at DESC
      LIMIT 100
    `).all()

    const clawbacks = db.prepare(`
      SELECT * FROM clawbacks
      ORDER BY created_at DESC
      LIMIT 100
    `).all()

    res.json({
      locks,
      clawbacks,
      counts: {
        locks: locks.length,
        clawbacks: clawbacks.length
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
})


app.listen(PORT, () => {
  console.log("=".repeat(72))
  console.log(`KFD console running: ${BASE_URL}`)
  console.log(`Server issuer: ${issuerWallet.classicAddress}`)
  console.log("Active issuanceId(48):", kvGet("KFD_ISSUANCE_ID"))
  console.log("Active issuanceIndex(64):", kvGet("KFD_ISSUANCE_INDEX"))
  console.log("=".repeat(72))
})
