async function apiGet(url) {
  let r;
  try {
    r = await fetch(url, { cache: "no-store" });
  } catch (e) {
    throw new Error(`fetch failed: ${url} (${e?.message || e})`);
  }
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`[${r.status}] ${url} - ${j?.error || j?.message || text}`);
  return j;
}

async function apiPost(url, body) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
  } catch (e) {
    throw new Error(`fetch failed: ${url} (${e?.message || e})`);
  }
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`[${r.status}] ${url} - ${j?.error || j?.message || text}`);
  return j;
}

function hexToUtf8(hex) {
  try {
    if (!hex) return "";
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function show(id) { const el = document.getElementById(id); if (el) el.classList.remove("hidden"); }
function hide(id) { const el = document.getElementById(id); if (el) el.classList.add("hidden"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let loginUuid = null;
let burnUuid = null;
let nftsCache = [];
const resolvedNftInfo = new Map(); // NFTokenID -> { name, imageUrl, metaUrl, uri }

// ---- 新增：紀錄當前選取的商品資訊 ----
let currentSelectedProductName = "";
let currentSelectedProductImage = "";

function tokenIdShort(id) {
  const s = String(id || "");
  if (s.length <= 18) return s;
  return s.slice(0, 8) + "…" + s.slice(-8);
}

// ---- Locker UI control ----
let lockerOpenedOnce = false;

function resetLockerUI() {
  lockerOpenedOnce = false;
  const locker = document.getElementById("locker");
  const led = document.getElementById("locker-led");
  const insideImg = document.getElementById("locker-inside-img");

  if (locker) locker.classList.remove("open");
  if (led) {
    led.classList.remove("open");
    led.classList.add("ready");
  }
  if (insideImg) insideImg.removeAttribute("src");
}

function openLockerUI() {
  if (lockerOpenedOnce) return;
  lockerOpenedOnce = true;

  const locker = document.getElementById("locker");
  const led = document.getElementById("locker-led");
  const insideImg = document.getElementById("locker-inside-img");

  if (insideImg) {
    // 預設顯示 NFT 本身的圖片
    let finalImage = currentSelectedProductImage; 
    
    // 將商品名稱轉為小寫以便比對
    const nameLower = (currentSelectedProductName || "").toLowerCase();

    // 依照商品名稱設定對應的圖片 (支援英文與中文關鍵字)
    if (nameLower.includes("coffee") || nameLower.includes("americano") || nameLower.includes("咖啡") || nameLower.includes("美式")) {
      finalImage = "image1.PNG";
    } else if (nameLower.includes("latte") || nameLower.includes("拿鐵")) {
      finalImage = "image2.PNG";
    } else if (nameLower.includes("tiramisu") || nameLower.includes("提拉米蘇")) {
      finalImage = "image3.PNG";
    }

    // 載入對應圖片
    if (finalImage) insideImg.src = finalImage;
  }

  if (led) {
    led.classList.remove("ready");
    led.classList.add("open");
  }
  if (locker) locker.classList.add("open");

  // replay burst animation
  const burst = locker?.nextElementSibling;
  if (burst && burst.classList.contains("open-burst")) {
    burst.style.animation = "none";
    burst.offsetHeight;
    burst.style.animation = "";
  }
}

// ---- NFT resolve (server-side to avoid CORS) ----
async function resolveNftInfo(nft) {
  const tokenId = nft?.NFTokenID;
  if (!tokenId) return null;
  if (resolvedNftInfo.has(tokenId)) return resolvedNftInfo.get(tokenId);

  const uri = hexToUtf8(nft?.URI || "");
  const fallback = { name: "NFT Item", imageUrl: "", metaUrl: "", uri };

  if (!uri) {
    resolvedNftInfo.set(tokenId, fallback);
    return fallback;
  }

  try {
    const r = await apiGet(`/api/resolve-uri?uri=${encodeURIComponent(uri)}`);
    const info = {
      name: r?.name || "NFT Item",
      imageUrl: r?.imageUrl || "",
      metaUrl: r?.metaUrl || "",
      uri
    };
    resolvedNftInfo.set(tokenId, info);
    return info;
  } catch (e) {
    console.warn("resolve-uri failed:", uri, e.message);
    resolvedNftInfo.set(tokenId, fallback);
    return fallback;
  }
}

function highlightSelectedCard() {
  const grid = document.getElementById("nft-grid");
  const sel = document.getElementById("nft-select");
  if (!grid || !sel) return;
  const id = sel.value;
  for (const el of grid.querySelectorAll(".nft-card")) {
    el.classList.toggle("selected", el.dataset.tokenid === id);
  }
}

function setPreview(info, tokenId) {
  const box = document.getElementById("nft-preview");
  if (!box) return;

  const name = info?.name || "NFT Item";
  const img = info?.imageUrl || "";
  const meta = info?.metaUrl || "";
  const uri = info?.uri || "";

  // 更新全域變數：紀錄當前商品名稱與圖片
  currentSelectedProductName = name;
  currentSelectedProductImage = img;

  box.innerHTML = `
    ${img ? `<img src="${img}" alt="nft" onerror="this.style.display='none'">` : ""}
    <div class="text-warmBrown/80 font-semibold text-sm leading-relaxed">
      <div class="text-warmBrown font-extrabold text-base mb-1">Selected: ${name}</div>
      <div>TokenID: ${tokenIdShort(tokenId)}</div>
      ${uri ? `<div class="break-all">URI: ${uri}</div>` : ""}
      ${meta ? `<div class="break-all">HTTP: ${meta}</div>` : ""}
    </div>
  `;
}

async function renderNftGrid(nfts) {
  const grid = document.getElementById("nft-grid");
  const sel = document.getElementById("nft-select");
  if (!grid || !sel) return;

  sel.innerHTML = "";
  grid.innerHTML = "";

  for (const nft of nfts) {
    const id = nft.NFTokenID || "";
    const info = await resolveNftInfo(nft);

    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info?.name ? `${info.name} (${tokenIdShort(id)})` : tokenIdShort(id);
    sel.appendChild(opt);

    const card = document.createElement("div");
    card.className = "nft-card";
    card.dataset.tokenid = id;

    const img = document.createElement("img");
    img.className = "nft-thumb";
    img.alt = info?.name || "NFT Item";
    if (info?.imageUrl) img.src = info.imageUrl;
    img.onerror = () => {
      img.removeAttribute("src");
      img.style.background = "rgba(234,224,213,.55)";
    };

    const meta = document.createElement("div");
    meta.className = "nft-meta";
    meta.innerHTML = `
      <div class="nft-name">${info?.name || "NFT Item"}</div>
      <div class="nft-id">${tokenIdShort(id)}</div>
    `;

    card.appendChild(img);
    card.appendChild(meta);

    // 點擊卡片時，記錄資訊並自動前往產生 Burn QR
    card.addEventListener("click", () => {
      sel.value = id;
      highlightSelectedCard();
      setPreview(info, id);
      createBurnQR().catch((e) => alert(e.message));
    });

    grid.appendChild(card);
  }

  // 預設選中第一個商品
  if (nfts.length > 0) {
    const firstId = nfts[0].NFTokenID;
    sel.value = firstId;
    highlightSelectedCard();
    const firstInfo = await resolveNftInfo(nfts[0]);
    setPreview(firstInfo, firstId);
  }

  // 下拉選單變化時 (雖然已被隱藏，但保險起見保留邏輯)
  sel.addEventListener("change", async () => {
    const id = sel.value;
    highlightSelectedCard();
    const nft = nftsCache.find((x) => (x.NFTokenID || "") === id);
    const info = nft ? await resolveNftInfo(nft) : null;
    setPreview(info, id);
  });
}

async function loadNFTs() {
  const btn = document.getElementById("btn-create-burn");
  if (btn) btn.disabled = true;

  setText("nft-count", "Loading…");

  const resp = await apiGet(`/api/nfts?uuid=${encodeURIComponent(loginUuid)}`);
  nftsCache = resp.nfts || [];

  setText("nft-count", String(nftsCache.length));

  if (!nftsCache.length) {
    setHtml("nft-preview", `<span class="font-bold text-red-600">No redeemable NFTs found</span>`);
    return;
  }

  await renderNftGrid(nftsCache);

  if (btn) {
    btn.disabled = false;
    btn.onclick = () => createBurnQR().catch((e) => alert(e.message));
  }
}

async function startLogin() {
  const login = await apiGet("/api/login");
  loginUuid = login.uuid;

  const qrEl = document.getElementById("login-qr");
  if (qrEl) qrEl.src = login.qr;

  setText("login-uuid", loginUuid);
  setText("login-status", "Waiting for scan…");
  setText("login-account", "");

  while (true) {
    try {
      const st = await apiGet(`/api/login/status?uuid=${encodeURIComponent(loginUuid)}`);

      if (st.signed && st.account) {
        setHtml("login-status", `<span class="text-sageGreen font-extrabold">Signed in</span>`);
        setText("login-account", `Account: ${st.account}`);

        try {
          await loadNFTs();
          show("step-select");
        } catch (e) {
          setHtml("login-status", `<span class="text-red-600 font-extrabold">Failed to load NFTs:</span> ${e.message}`);
        }
        return;
      }

      if (st.cancelled) {
        setHtml("login-status", `<span class="text-red-600 font-extrabold">Cancelled</span>`);
        return;
      }

      setText("login-status", "Waiting for scan…");
    } catch (e) {
      setHtml("login-status", `<span class="text-red-600 font-extrabold">Polling failed:</span> ${e.message}`);
    }

    await sleep(1500);
  }
}

async function createBurnQR() {
  const sel = document.getElementById("nft-select");
  if (!sel) throw new Error("Missing nft-select");

  const nftokenId = sel.value;
  if (!nftokenId) throw new Error("Please select an NFT first");

  resetLockerUI();
  setHtml("unlock-status", "—");
  setHtml("burn-status", "Waiting for signature…");

  const resp = await apiPost("/api/redeem", { uuid: loginUuid, nftokenId });
  burnUuid = resp.burnUuid;

  const qrEl = document.getElementById("burn-qr");
  if (qrEl) qrEl.src = resp.qr;

  show("step-burn");
  await pollBurnStatus();
}

async function pollBurnStatus() {
  while (true) {
    try {
      const st = await apiGet(`/api/redeem/status?uuid=${encodeURIComponent(burnUuid)}`);
      const ok = (st.signed && st.txid) || st.burnedOnChain;

      if (ok) {
        setHtml("burn-status", `<span class="text-sageGreen font-extrabold">Burn confirmed</span>`);

        if (st.unlocked) {
          setHtml("unlock-status", `<span class="text-sageGreen font-extrabold">Door opened ✅</span>`);
          openLockerUI();
          return;
        }

        setHtml("unlock-status", `<span class="text-amberGlow font-extrabold">Opening…</span>`);
      } else if (st.cancelled) {
        setHtml("burn-status", `<span class="text-red-600 font-extrabold">Cancelled</span>`);
        setHtml("unlock-status", "—");
        resetLockerUI();
        return;
      } else {
        setHtml("burn-status", `<span class="text-amberGlow font-extrabold">Waiting for signature…</span>`);
      }
    } catch (e) {
      setHtml("burn-status", `<span class="text-red-600 font-extrabold">Polling failed:</span> ${e.message}`);
    }

    await sleep(1500);
  }
}

startLogin().catch((e) => {
  setHtml("login-status", `<span class="text-red-600 font-extrabold">Startup failed:</span> ${e.message}`);
});