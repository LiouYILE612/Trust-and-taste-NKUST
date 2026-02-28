// server.js (Virtual self-service locker)
// - Xaman SignIn
// - List account NFTs (filter by ISSUER_ADDRESS)
// - Resolve NFT URI -> metadata/image (server-side, avoids browser CORS)
//   * Special fix: URI like https://<ngrok>/nft/meta/<CID> will be resolved via IPFS gateways using <CID>
//     so we don't depend on Vite/ngrok host allowlist.
// - Redeem: NFTokenBurn; burn confirmed => console "[OPEN]" and set unlocked=true

require("dotenv").config();

const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first"); // helps on some Windows/IPv6 DNS cases

const express = require("express");
const path = require("path");
const { XummSdk } = require("xumm-sdk");
const xrpl = require("xrpl");

// ---------------------- Env ----------------------
const PORT = Number(process.env.PORT) || 3060;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const XAMAN_API_KEY = process.env.XAMAN_API_KEY;
const XAMAN_API_SECRET = process.env.XAMAN_API_SECRET;

const XRPL_WSS = process.env.XRPL_WSS || "wss://s.altnet.rippletest.net:51233";
const ISSUER_ADDRESS = (process.env.ISSUER_ADDRESS || "").trim();

// Optional: comma-separated IPFS gateways
// Example: IPFS_GATEWAYS=https://nftstorage.link/ipfs/,https://ipfs.io/ipfs/,https://cloudflare-ipfs.com/ipfs/
const IPFS_GATEWAYS = (
  process.env.IPFS_GATEWAYS
    ? process.env.IPFS_GATEWAYS.split(",")
    : [
        process.env.IPFS_GATEWAY || "https://nftstorage.link/ipfs/",
        "https://ipfs.io/ipfs/",
        "https://cloudflare-ipfs.com/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
      ]
)
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------- Basic validation ----------------------
if (!XAMAN_API_KEY || !XAMAN_API_SECRET) {
  console.error("Missing XAMAN_API_KEY / XAMAN_API_SECRET in .env");
  process.exit(1);
}
if (!ISSUER_ADDRESS) {
  console.error("Missing ISSUER_ADDRESS in .env (used to filter your issued NFTs)");
  process.exit(1);
}

const xumm = new XummSdk(XAMAN_API_KEY, XAMAN_API_SECRET);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory stores (restart clears)
const sessions = new Map(); // login_uuid -> { account, createdAt }
const redeems = new Map(); // burn_uuid -> { account, nftokenId, unlocked }

// ---------------------- Helpers ----------------------
function normalizeIpfsGateway(gw) {
  let s = String(gw || "").trim();
  if (!s) return "";
  if (!s.endsWith("/")) s += "/";
  if (!s.includes("/ipfs/")) s += "ipfs/";
  if (!s.endsWith("/")) s += "/";
  return s;
}
const NORMALIZED_IPFS_GATEWAYS = IPFS_GATEWAYS.map(normalizeIpfsGateway).filter(Boolean);

function isIpfsCid(x) {
  const s = String(x || "").trim();
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]{20,})$/i.test(s);
}

function ipfsCidFromUri(uri) {
  const s = String(uri || "").trim();

  if (s.startsWith("ipfs://ipfs/")) return s.slice("ipfs://ipfs/".length);
  if (s.startsWith("ipfs://")) return s.slice("ipfs://".length);

  if (s.startsWith("/ipfs/")) return s.slice("/ipfs/".length);

  if (isIpfsCid(s)) return s;

  return null;
}

// ✅ Extract CID from many URL patterns, especially: https://<host>/nft/meta/<CID>
function extractCidFromUri(uri) {
  const direct = ipfsCidFromUri(uri);
  if (direct) return direct;

  const s = String(uri || "").trim();
  try {
    const u = new URL(s);
    const parts = u.pathname.split("/").filter(Boolean);

    // Search from end: last segment that looks like CID
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (isIpfsCid(p)) return p;
    }
  } catch {
    // not a URL
  }

  return null;
}

// SSRF / proxy control: allow only known-safe hosts
const ALLOWED_HOST_SUFFIXES = [
  "nftstorage.link",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "dweb.link",
  "w3s.link",
];

function isAllowedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s))) return true;
  if (h.endsWith(".ngrok-free.dev")) return true; // allow reading metadata from ngrok (if possible)
  if (h.endsWith(".ngrok.app")) return true;
  return false;
}

function buildFetchHeaders(targetUrl) {
  const headers = {
    accept: "*/*",
    "user-agent": "Mozilla/5.0",
  };

  // Some ngrok setups show an interstitial unless this header is present.
  // (It won't bypass Vite allowedHosts 403, but harmless.)
  try {
    const u = new URL(targetUrl);
    const h = u.hostname.toLowerCase();
    if (h.endsWith(".ngrok-free.dev") || h.endsWith(".ngrok.app")) {
      headers["ngrok-skip-browser-warning"] = "1";
    }
  } catch {}

  return headers;
}

// Node 18+ has global fetch; else use node-fetch
async function fetchWithTimeout(url, { timeoutMs = 25000, ...opts } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const f =
    globalThis.fetch ||
    (await import("node-fetch").then((m) => m.default));

  try {
    return await f(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function pickImageFromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";

  const direct =
    meta.image ||
    meta.image_url ||
    meta.imageUrl ||
    meta.imageURI ||
    "";

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const pFiles = meta?.properties?.files;
  if (Array.isArray(pFiles) && pFiles[0]) {
    const v = pFiles[0].uri || pFiles[0].url || pFiles[0].href;
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const files = meta?.files;
  if (Array.isArray(files) && files[0]) {
    const v = files[0].uri || files[0].url || files[0].href;
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const nested =
    meta?.content?.image ||
    meta?.content?.image_url ||
    meta?.links?.image ||
    meta?.data?.image ||
    meta?.data?.image_url ||
    "";

  return typeof nested === "string" ? nested.trim() : "";
}

function pickNameFromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";

  const n1 = meta.name || meta.title || meta.collection?.name;
  if (typeof n1 === "string" && n1.trim()) return n1.trim();

  const n2 = meta?.properties?.name;
  if (typeof n2 === "string" && n2.trim()) return n2.trim();

  const attrs = meta.attributes;
  if (Array.isArray(attrs)) {
    const hit = attrs.find((a) => {
      const t = String(a?.trait_type || "").toLowerCase();
      return t === "name" || t === "product" || t === "title";
    });
    const v = hit?.value;
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return "";
}

function resolveImageUrl(imageRaw, baseUrlForRelative) {
  const raw = String(imageRaw || "").trim();
  if (!raw) return "";

  const cid = ipfsCidFromUri(raw) || (isIpfsCid(raw) ? raw : null);
  if (cid && NORMALIZED_IPFS_GATEWAYS.length) {
    return NORMALIZED_IPFS_GATEWAYS[0] + cid;
  }

  if (/^https?:\/\//i.test(raw)) return raw;

  // relative -> resolve against metadata URL
  try {
    return new URL(raw, baseUrlForRelative).href;
  } catch {
    return "";
  }
}

async function getAccountNFTs(account) {
  const client = new xrpl.Client(XRPL_WSS, { timeout: 20000 });
  try {
    await client.connect();
    const resp = await client.request({
      command: "account_nfts",
      account,
      limit: 400,
    });
    return resp.result.account_nfts || [];
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

// ---------------------- Routes ----------------------
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 1) Create SignIn payload
app.get("/api/login", async (req, res) => {
  try {
    const payload = await xumm.payload.create({
      txjson: { TransactionType: "SignIn" },
    });

    res.json({
      uuid: payload.uuid,
      qr: payload.refs.qr_png,
      websocket: payload.refs.websocket_status,
      next: `${BASE_URL}/api/login/status?uuid=${encodeURIComponent(payload.uuid)}`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 2) Check SignIn status
app.get("/api/login/status", async (req, res) => {
  const uuid = String(req.query.uuid || "").trim();
  if (!uuid) return res.status(400).json({ error: "missing uuid" });

  try {
    const p = await xumm.payload.get(uuid);

    const resolved = !!p?.meta?.resolved;
    const signed = !!p?.meta?.signed;
    const cancelled = !!p?.meta?.cancelled;

    const account = p?.response?.account || p?.meta?.account || null;

    if (signed && account) {
      sessions.set(uuid, { account, createdAt: Date.now() });
    }

    res.json({ resolved, signed, cancelled, account });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 3) List NFTs (filter by issuer)
app.get("/api/nfts", async (req, res) => {
  const uuid = String(req.query.uuid || "").trim();
  if (!uuid) return res.status(400).json({ error: "missing uuid" });

  const s = sessions.get(uuid);
  if (!s?.account) return res.status(401).json({ error: "not logged in" });

  try {
    const nfts = await getAccountNFTs(s.account);
    const filtered = nfts.filter((n) => {
      const issuer = (n.Issuer || n.issuer || "").trim();
      return issuer && issuer.toUpperCase() === ISSUER_ADDRESS.toUpperCase();
    });

    res.json({ account: s.account, count: filtered.length, nfts: filtered });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 4) Resolve URI -> metadata/image (server-side)
// ✅ Important: always return 200 with kind/error to avoid breaking Step 2 rendering.
app.get("/api/resolve-uri", async (req, res) => {
  const uri = String(req.query.uri || "").trim();
  if (!uri) return res.status(400).json({ error: "missing uri" });
  if (uri.length > 4096) return res.status(400).json({ error: "uri too long" });

  const baseResp = {
    kind: "error",
    name: "NFT Item",
    uri,
    metaUrl: "",
    imageUrl: "",
    error: "",
    detail: "",
    tried: [],
  };

  try {
    // ✅ Key fix: if URI contains a CID (e.g. .../nft/meta/<CID>), prefer fetching from IPFS gateways.
    const cid = extractCidFromUri(uri);

    let candidates = [];
    if (cid && NORMALIZED_IPFS_GATEWAYS.length) {
      candidates = NORMALIZED_IPFS_GATEWAYS.map((g) => g + cid);

      // Optional fallback (likely 403 on Vite allowedHosts, but harmless)
      if (/^https?:\/\//i.test(uri)) candidates.push(uri);
    } else if (/^https?:\/\//i.test(uri)) {
      candidates = [uri];
    } else {
      baseResp.error = "uri must be http(s) or ipfs://";
      return res.json(baseResp);
    }

    // allowlist filter
    const filtered = [];
    for (const u of candidates) {
      try {
        const uu = new URL(u);
        if (isAllowedHost(uu.hostname)) filtered.push(u);
      } catch {}
    }
    baseResp.tried = filtered.slice(0, 6);

    if (!filtered.length) {
      baseResp.error = "no allowed host candidates";
      return res.json(baseResp);
    }

    // fetch candidates in order
    let lastErr = null;
    let finalUrl = null;
    let resp = null;

    for (const u of filtered) {
      try {
        resp = await fetchWithTimeout(u, {
          timeoutMs: 25000,
          headers: buildFetchHeaders(u),
        });
        finalUrl = u;
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!resp || !finalUrl) {
      baseResp.error = "fetch failed";
      baseResp.detail = String(lastErr?.message || lastErr || "unknown");
      return res.json(baseResp);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // (1) direct image
    if (ct.startsWith("image/")) {
      return res.json({
        kind: "image",
        name: "NFT Item",
        uri,
        metaUrl: finalUrl,
        imageUrl: finalUrl,
      });
    }

    // (2) metadata json
    const text = await resp.text();
    let meta = null;
    try {
      meta = JSON.parse(text);
    } catch {
      meta = null;
    }

    if (meta && typeof meta === "object") {
      const name = pickNameFromMeta(meta) || "NFT Item";
      const imageRaw = pickImageFromMeta(meta);
      let imageUrl = resolveImageUrl(imageRaw, finalUrl);

      // image host allowlist
      if (imageUrl) {
        try {
          const iu = new URL(imageUrl);
          if (!isAllowedHost(iu.hostname)) imageUrl = "";
        } catch {
          imageUrl = "";
        }
      }

      return res.json({
        kind: "metadata",
        name,
        uri,
        metaUrl: finalUrl,
        imageUrl,
      });
    }

    // (3) unknown (not image, not json)
    return res.json({
      kind: "unknown",
      name: "NFT Item",
      uri,
      metaUrl: finalUrl,
      imageUrl: "",
      error: "not image/json",
      detail: `content-type=${ct}`,
    });
  } catch (e) {
    baseResp.error = "resolve error";
    baseResp.detail = String(e?.message || e);
    return res.json(baseResp);
  }
});

// 5) Create burn payload
app.post("/api/redeem", async (req, res) => {
  const uuid = String(req.body?.uuid || "").trim();
  const nftokenId = String(req.body?.nftokenId || "").trim();

  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  if (!nftokenId) return res.status(400).json({ error: "missing nftokenId" });

  const s = sessions.get(uuid);
  if (!s?.account) return res.status(401).json({ error: "not logged in" });

  try {
    const payload = await xumm.payload.create(
      {
        txjson: {
          TransactionType: "NFTokenBurn",
          Account: s.account,
          NFTokenID: nftokenId,
        },
      },
      true
    );

    redeems.set(payload.uuid, { account: s.account, nftokenId, unlocked: false });

    res.json({
      burnUuid: payload.uuid,
      qr: payload.refs.qr_png,
      websocket: payload.refs.websocket_status,
      next: `${BASE_URL}/api/redeem/status?uuid=${encodeURIComponent(payload.uuid)}`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 6) Burn status: success => console "[OPEN]" (no external API)
app.get("/api/redeem/status", async (req, res) => {
  const burnUuid = String(req.query.uuid || "").trim();
  if (!burnUuid) return res.status(400).json({ error: "missing uuid" });

  try {
    const p = await xumm.payload.get(burnUuid);

    const resolved = !!p?.meta?.resolved;
    const signed = !!p?.meta?.signed;
    const cancelled = !!p?.meta?.cancelled;

    const txid =
      p?.response?.txid ||
      p?.meta?.txid ||
      p?.application?.txid ||
      null;

    const r = redeems.get(burnUuid) || { unlocked: false, account: null, nftokenId: null };

    // on-chain confirm burn by checking account_nfts
    let burnedOnChain = false;
    let chainError = null;

    if (signed && r.account && r.nftokenId) {
      const client = new xrpl.Client(XRPL_WSS, { timeout: 20000 });
      try {
        await client.connect();
        const resp = await client.request({
          command: "account_nfts",
          account: r.account,
          limit: 400,
        });

        const stillHas = (resp.result.account_nfts || []).some(
          (n) => (n.NFTokenID || "").toUpperCase() === r.nftokenId.toUpperCase()
        );
        burnedOnChain = !stillHas;
      } catch (e) {
        chainError = String(e?.message || e);
      } finally {
        try {
          await client.disconnect();
        } catch {}
      }
    }

    // success => display open (console) and mark unlocked
    let unlockResult = null;
    if (((signed && txid) || burnedOnChain) && !r.unlocked) {
      console.log("[OPEN] NFToken burned => unlock display", {
        burnUuid,
        account: r.account,
        nftokenId: r.nftokenId,
        txid: txid || null,
        burnedOnChain,
      });

      unlockResult = { ok: true, message: "OPEN" };
      redeems.set(burnUuid, { ...r, unlocked: true });
    }

    res.json({
      resolved,
      signed,
      cancelled,
      txid,
      burnedOnChain,
      chainError,
      unlocked: redeems.get(burnUuid)?.unlocked || false,
      unlockResult,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/logout", (req, res) => {
  const uuid = String(req.body?.uuid || "").trim();
  if (uuid) sessions.delete(uuid);
  res.json({ ok: true });
});

// ---------------------- Start ----------------------
app.listen(PORT, () => {
  console.log(`Locker server running on http://localhost:${PORT}`);
  console.log(`BASE_URL = ${BASE_URL}`);
  console.log(`XRPL_WSS = ${XRPL_WSS}`);
  console.log(`ISSUER_ADDRESS = ${ISSUER_ADDRESS}`);
  console.log(`IPFS_GATEWAYS = ${NORMALIZED_IPFS_GATEWAYS.join(", ")}`);
});