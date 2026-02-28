// ✅ main.js - Local Video Mode + MPT / XRP / RLUSD Payment

// --- 1. 變數與設定 ---

const messageInput = document.querySelector("#messageInput");
const voiceBtn = document.querySelector("#voiceBtn");
const sendBtn = document.querySelector("#sendBtn");
const chatContainer = document.querySelector("#chatContainer");
const endOrderBtn = document.querySelector("#endOrderBtn");
const cartFooter = document.querySelector("#cartFooter");
const paymentModal = document.querySelector("#paymentModal");

// 抓取影片元素
const vidIdle = document.getElementById("vidIdle");
const vidAction = document.getElementById("vidAction");

// 菜單資料
const menuItems = [
  { id: 1, name: "Classic Americano", name_zh: "經典美式咖啡", price: 1, category: "Coffee", category_zh: "咖啡系列", image: "☕️" },
  { id: 2, name: "Latte", name_zh: "拿鐵咖啡", price: 2, category: "Coffee", category_zh: "咖啡系列", image: "🥛" },
  { id: 3, name: "Tiramisu", name_zh: "提拉米蘇", price: 2, category: "Dessert", category_zh: "精選甜點", image: "🍰" },
];

let cart = [];
let paymentStarted = false;
let currentLang = "en"; // 預設英文

const PAYMENT_LABELS = {
  mpt: "MPT",
  xrp: "XRP",
  rlusd: "RLUSD",
};

// --- 2. 語言字典 ---
const translations = {
  en: {
    menuHeader: "HEADER MENU ☕",
    chatHeader: "ORDER CHAT 💬",
    agentHeader: "VIRTUAL BARISTA",
    inputPlaceholder: "Type your order...",
    cartLabel: "Cart:",
    itemsLabel: "items",
    totalLabel: "Total:",
    checkoutBtn: "Checkout",
    paymentTitle: "Select Payment Method",
    cancel: "Cancel",
    endReset: "End & Reset",
    welcomeText: "Hi there! Welcome to the AI Cafe. What can I get for you today? ☕",
    cartEmpty: "Your cart is empty.",
    added: "Added",
    resetMsg: "✅ Transaction reset. You can start a new order.",
    scanPay: "Please scan to pay:",
    creatingOrder: "Creating order...",
    polling: "Checking payment status...",
    paymentSuccess: "Payment successful! Please scan to claim your NFTs.",
    processingCard: "💳 Processing Credit Card...",
    paymentSuccessCard: "✅ Payment Successful!",
    aiError: "AI service error.",
    sorry: "Sorry, I didn't catch that.",
    help: "How can I help you?",
    orderCreated: "Order created. Total is",
    errPrefix: "❌ Error:",
    pollTimeout: "⏳ Payment is taking longer than expected. Please refresh or try checkout again.",
    orderMissing: "⚠️ Order info no longer exists. Please checkout again.",
    unknownStatus: "⚠️ Unknown status:",
  },
  zh: {
    menuHeader: "精選菜單 ☕",
    chatHeader: "點餐對話 💬",
    agentHeader: "虛擬咖啡店員",
    inputPlaceholder: "請輸入您的餐點...",
    cartLabel: "購物車:",
    itemsLabel: "項",
    totalLabel: "總計:",
    checkoutBtn: "去結帳",
    paymentTitle: "選擇付款方式",
    cancel: "取消",
    endReset: "結束並重置",
    welcomeText: "你好！歡迎光臨 AI 咖啡廳，今天想喝點什麼呢？☕",
    cartEmpty: "購物車是空的喔。",
    added: "已加入",
    resetMsg: "✅ 交易已結束，您可以開始新的訂單。",
    scanPay: "請掃描 QR Code 付款：",
    creatingOrder: "正在建立訂單...",
    polling: "正在確認付款狀態...",
    paymentSuccess: "付款成功！請掃描下方 QR 領取您的 NFT。",
    processingCard: "💳 信用卡處理中...",
    paymentSuccessCard: "✅ 付款成功！",
    aiError: "AI 服務暫時無法使用。",
    sorry: "抱歉，我沒聽清楚，請再說一次。",
    help: "有什麼我可以幫您的嗎？",
    orderCreated: "訂單已建立，總金額是",
    errPrefix: "❌ 錯誤：",
    pollTimeout: "⏳ 等待時間較久，請重新整理或重新結帳再試一次。",
    orderMissing: "⚠️ 訂單資訊不存在（可能 server 重啟或 uuid 已過期）。請重新結帳再試一次。",
    unknownStatus: "⚠️ 未知狀態：",
  },
};

function t(key) {
  return translations[currentLang][key] || key;
}

// --- 3. 影片播放核心邏輯 ---

const videoMap = {
  idle: "idle.mp4",
  welcome: "welcome.mp4",
  add: "add.mp4",
  checkout: "checkout.mp4",
  error: "error.mp4",
  pay: "pay.mp4",
  success: "success.mp4",
  thanks: "thanks.mp4",
};

function playVideo(intent) {
  const filename = videoMap[intent] || videoMap.idle;
  const p = `/assets/${currentLang}/${filename}`;

  console.log(`🎬 Loading: ${p} (${intent})`);

  vidAction.src = p;
  vidAction.muted = false;

  const playPromise = vidAction.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        setTimeout(() => {
          vidIdle.style.opacity = 0;
          vidAction.style.opacity = 1;
        }, 100);
      })
      .catch((e) => console.error("Video play error:", e));
  }

  vidAction.onended = () => {
    vidAction.style.opacity = 0;
    vidIdle.style.opacity = 1;
    vidIdle.play().catch(() => {});
  };
}

// --- 4. 語言與介面 ---

document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".lang-btn").forEach((b) => b.classList.remove("active"));
    e.target.classList.add("active");

    currentLang = e.target.dataset.lang;
    document.getElementById("startButton").innerText = currentLang === "zh" ? "👉 開始點餐" : "👉 Start Ordering";

    vidIdle.src = `/assets/${currentLang}/idle.mp4`;
    vidIdle.play().catch(() => {});
  });
});

function updateUIText() {
  document.getElementById("menuHeader").innerText = t("menuHeader");
  document.getElementById("chatHeader").innerText = t("chatHeader");
  document.getElementById("agentHeader").innerText = t("agentHeader");
  document.getElementById("messageInput").placeholder = t("inputPlaceholder");
  document.getElementById("cartLabel").innerText = t("cartLabel");
  document.getElementById("itemsLabel").innerText = t("itemsLabel");
  document.getElementById("totalLabel").innerText = t("totalLabel");
  document.getElementById("checkoutBtn").innerText = t("checkoutBtn");
  document.getElementById("paymentTitle").innerText = t("paymentTitle");
  document.getElementById("cancelPay").innerText = t("cancel");
  document.getElementById("endOrderBtn").innerText = t("endReset");
  renderMenu();
}

// --- 5. 業務邏輯 ---

function addMessage(type, text, opts = {}) {
  const bubbleClass = type === "user" ? "user" : "bot";
  const wideStyle = opts.wide ? "max-width: 100%;" : "";
  const html = `<div class="chat-bubble ${bubbleClass}" style="${wideStyle}">${text}</div>`;
  chatContainer.insertAdjacentHTML("beforeend", html);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function renderMenu() {
  const container = document.getElementById("menuContainer");
  if (!container) return;

  const uniqueCategories = [...new Set(menuItems.map((i) => i.category))];

  container.innerHTML = uniqueCategories
    .map((catKey) => {
      const sampleItem = menuItems.find((i) => i.category === catKey);
      const displayCategory = currentLang === "zh" ? sampleItem.category_zh : sampleItem.category;
      const itemsInCat = menuItems.filter((i) => i.category === catKey);

      const cardsHtml = itemsInCat
        .map((i) => {
          const displayName = currentLang === "zh" ? i.name_zh : i.name;
          return `
          <div class="menu-item-card" onclick="window.globalFunctions.addToCart(${i.id})">
            <div class="menu-icon">${i.image}</div>
            <div class="menu-details">
              <div class="menu-name">${displayName}</div>
              <div class="menu-price">$${i.price.toFixed(2)}</div>
            </div>
          </div>`;
        })
        .join("");

      return `
        <div class="menu-category-group">
            <h3 class="menu-category-title">${displayCategory}</h3>
            <div class="menu-items-grid">
                ${cardsHtml}
            </div>
        </div>
      `;
    })
    .join("");
}

function addToCart(id) {
  hideEndBtn();
  const i = menuItems.find((x) => x.id === id);
  if (!i) return;
  cart.push(i);
  updateCart();

  const displayName = currentLang === "zh" ? i.name_zh : i.name;
  addMessage("bot", `${t("added")}: ${displayName}`);
  playVideo("add");
}
window.globalFunctions = { addToCart };

function updateCart() {
  document.getElementById("cartCount").textContent = cart.length;
  const total = cart.reduce((s, x) => s + x.price, 0);
  document.getElementById("totalPrice").textContent = total.toFixed(2);
  if (cart.length > 0) cartFooter.classList.remove("hidden");
  else cartFooter.classList.add("hidden");
}

async function handleAiOrderText(text) {
  if (!text || !text.trim()) return;
  addMessage("user", text);
  hideEndBtn();

  try {
    const r = await fetch("/ai-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: currentLang }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "AI Error");

    const acts = Array.isArray(data.actions) ? data.actions : [];
    let addedNames = [];

    if (data.parsed && data.parsed.intent === "help") {
      addMessage("bot", data.parsed.raw_text || t("help"));
      playVideo("welcome");
      return;
    }

    for (const a of acts) {
      if (a.type === "add_to_cart" && a.product_id) {
        const item = menuItems.find((m) => m.id == a.product_id);
        if (item) {
          for (let i = 0; i < (a.qty || 1); i++) cart.push(item);
          const displayName = currentLang === "zh" ? item.name_zh : item.name;
          addedNames.push(`${displayName} × ${a.qty || 1}`);
        }
      }
    }

    if (addedNames.length) {
      updateCart();
      addMessage("bot", `${t("added")}: ${addedNames.join(", ")}`);
      playVideo("add");
    } else if (!acts.some((a) => a.type === "checkout")) {
      addMessage("bot", data.parsed.raw_text || t("sorry"));
      playVideo("error");
    }

    if (acts.some((a) => a.type === "checkout")) openCheckout();
  } catch (e) {
    console.error("AI Error:", e);
    addMessage("bot", t("aiError"));
    playVideo("error");
  }
}

function openCheckout() {
  if (!cart.length) {
    addMessage("bot", t("cartEmpty"));
    playVideo("error");
    return;
  }
  paymentModal.classList.remove("hidden");
  playVideo("checkout");
}

// --- 6. 支付與 NFT ---

function savePayloadUuid(u) {
  if (u) localStorage.setItem("xumm_payload_uuid", u);
  else localStorage.removeItem("xumm_payload_uuid");
}
function getSavedPayloadUuid() {
  return localStorage.getItem("xumm_payload_uuid");
}
function hideEndBtn() {
  if (endOrderBtn) endOrderBtn.classList.add("hidden");
}

function deriveXummQr({ qr, url, uuid }) {
  if (qr && (/\/qr(\?.*)?$/.test(qr) || /\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(qr))) return qr;
  if (url && /xumm\.app\/sign\/([a-f0-9-]{36})/i.test(url)) {
    const id = url.match(/xumm\.app\/sign\/([a-f0-9-]{36})/i)[1];
    return `https://xumm.app/api/v1/platform/payload/${id}/qr`;
  }
  if (uuid) {
    return `https://xumm.app/api/v1/platform/payload/${uuid}/qr`;
  }
  return "";
}

function resolveMediaUrl(u) {
  if (!u) return "";
  if (u.startsWith("ipfs://")) {
    const cid = u.replace("ipfs://", "").replace(/^ipfs\//, "");
    return `https://gateway.pinata.cloud/ipfs/${cid}`;
  }
  return `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// ✅ 建立 items 給後端：[{product_id, qty}]
function buildItemsForApi() {
  const map = new Map();
  for (const it of cart) {
    map.set(it.id, (map.get(it.id) || 0) + 1);
  }
  return Array.from(map.entries()).map(([product_id, qty]) => ({ product_id, qty }));
}

async function pollBuyStatus(payloadUuid) {
  if (!payloadUuid) return;

  if (window.__buyStatusTimer) {
    clearInterval(window.__buyStatusTimer);
    window.__buyStatusTimer = null;
  }

  const startedAt = Date.now();
  const MAX_POLL_MS = 3 * 60 * 1000;
  const POLL_INTERVAL_MS = 2500;

  if (window.__buyStatusDoneFor === payloadUuid) return;

  hideEndBtn();

  window.__buyStatusTimer = setInterval(async () => {
    try {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        clearInterval(window.__buyStatusTimer);
        window.__buyStatusTimer = null;

        if (window.__buyStatusDoneFor === payloadUuid || window.nftShown) return;

        addMessage("bot", t("pollTimeout"));
        playVideo("error");
        return;
      }

      const res = await fetch(`/buy/status?payload_uuid=${encodeURIComponent(payloadUuid)}&t=${Date.now()}`);
      const data = await res.json();

      if (data?.status === "pending") return;

      if (data?.status === "success") {
        clearInterval(window.__buyStatusTimer);
        window.__buyStatusTimer = null;

        if (window.__buyStatusDoneFor === payloadUuid || window.nftShown) return;
        window.__buyStatusDoneFor = payloadUuid;
        window.nftShown = true;

        let nftHtml = "";
        if (Array.isArray(data.nfts) && data.nfts.length > 0) {
          const cards = data.nfts
            .map((n, i) => {
              const img = resolveMediaUrl(n.image);
              return `
              <div class="nft-card">
                <span style="color:var(--accent-color)">#${i + 1} ${n.name}</span>
                ${img ? `<img src="${img}" />` : ""}
              </div>`;
            })
            .join("");
          nftHtml = `<div class="nft-grid">${cards}</div>`;
        }

        let qrListHtml = "";
        if (Array.isArray(data.accept_qr_list) && data.accept_qr_list.length > 0) {
          const cards = data.accept_qr_list
            .map((a, i) => {
              const openLink = a.url
                ? `<a href="${a.url}" target="_blank" style="color:blue;text-decoration:underline;">Open Xumm</a>`
                : "";
              return `
              <div class="nft-card" style="background:#fff;">
                <p style="color:var(--accent-color)">Claim #${i + 1} - ${a.product || ""}</p>
                ${a.qr ? `<img src="${a.qr}" style="width:120px;height:120px;margin:0 auto;">` : ""}
                ${openLink}
              </div>`;
            })
            .join("");
          qrListHtml = `<div class="nft-grid">${cards}</div>`;
        }

        const payMethodText = data?.payment_method ? `<p><b>${PAYMENT_LABELS[data.payment_method] || data.payment_method}</b></p>` : "";

        const finalHtml = `
          <div>
            ${payMethodText}
            <p>${t("paymentSuccess")}</p>
            ${nftHtml}
            ${qrListHtml ? `<p style="margin-top:15px;">Scan:</p>${qrListHtml}` : ""}
          </div>
        `;

        addMessage("bot", finalHtml, { wide: true });
        playVideo("success");

        savePayloadUuid(null);

        cart = [];
        updateCart();
        setTimeout(() => {
          if (endOrderBtn) endOrderBtn.classList.remove("hidden");
        }, 600);

        return;
      }

      if (data?.status === "no_order" || data?.status === "completed_or_expired") {
        if (window.__buyStatusDoneFor === payloadUuid || window.nftShown) {
          clearInterval(window.__buyStatusTimer);
          window.__buyStatusTimer = null;
          savePayloadUuid(null);
          return;
        }

        clearInterval(window.__buyStatusTimer);
        window.__buyStatusTimer = null;

        addMessage("bot", t("orderMissing"));
        playVideo("error");
        savePayloadUuid(null);
        return;
      }

      if (data?.status === "error") {
        clearInterval(window.__buyStatusTimer);
        window.__buyStatusTimer = null;

        const msg = data?.error ? `❌ ${data.error}` : "❌ 發生錯誤";
        addMessage("bot", msg);
        playVideo("error");
        savePayloadUuid(null);
        return;
      }

      clearInterval(window.__buyStatusTimer);
      window.__buyStatusTimer = null;
      addMessage("bot", `${t("unknownStatus")} ${data?.status || "unknown"}`);
      playVideo("error");
      savePayloadUuid(null);
    } catch (err) {
      console.error("Poll Error:", err);
    }
  }, POLL_INTERVAL_MS);
}

async function startLedgerPayment(method) {
  paymentModal.classList.add("hidden");
  hideEndBtn();

  if (!cart.length) {
    addMessage("bot", t("cartEmpty"));
    playVideo("error");
    return;
  }

  addMessage("bot", `<small style="opacity:.8">${t("creatingOrder")} (${PAYMENT_LABELS[method] || method})</small>`);
  playVideo("pay");

  try {
    const items = buildItemsForApi();

    const res = await fetch("/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        payment_method: method,
      }),
    });

    const j = await res.json();

    if (!res.ok) {
      addMessage("bot", `${t("errPrefix")} ${j.error || "create-order failed"}`);
      playVideo("error");
      return;
    }

    const payQr = deriveXummQr({
      qr: j.xumm_qr,
      url: j.xumm_payload_url,
      uuid: j.payload_uuid,
    });

    addMessage(
      "bot",
      `${t("scanPay")} (${PAYMENT_LABELS[j.payment_method] || j.payment_method || method})<br>
       <small style="opacity:.75">payload_uuid: <code>${j.payload_uuid}</code></small><br>
       <img src="${payQr}" style="width:280px; border-radius:10px;">`,
      { wide: true }
    );

    if (j.payload_uuid) {
      savePayloadUuid(j.payload_uuid);
      pollBuyStatus(j.payload_uuid);
    } else {
      addMessage("bot", `${t("errPrefix")} missing payload_uuid`);
      playVideo("error");
    }

    cart = [];
    updateCart();
  } catch (e) {
    console.error(e);
    addMessage("bot", `${t("errPrefix")} ${e.message || e}`);
    playVideo("error");
  }
}

// --- 7. 事件綁定 ---

document.getElementById("checkoutBtn").addEventListener("click", openCheckout);
document.getElementById("cancelPay").onclick = () => paymentModal.classList.add("hidden");

// ✅ Ledger Payment Buttons
document.getElementById("kfdPay")?.addEventListener("click", () => startLedgerPayment("mpt"));
document.getElementById("xrpPay")?.addEventListener("click", () => startLedgerPayment("xrp"));
document.getElementById("rlusdPay")?.addEventListener("click", () => startLedgerPayment("rlusd"));

// 信用卡（保留）
document.getElementById("creditPay").onclick = () => {
  paymentModal.classList.add("hidden");
  hideEndBtn();
  addMessage("bot", t("processingCard"));
  setTimeout(() => {
    addMessage("bot", t("paymentSuccessCard"));
    playVideo("success");
    cart = [];
    updateCart();
    if (endOrderBtn) endOrderBtn.classList.remove("hidden");
  }, 2000);
};

if (endOrderBtn) {
  endOrderBtn.addEventListener("click", () => {
    if (confirm("Reset?")) {
      window.nftShown = false;
      window.__buyStatusDoneFor = null;
      if (window.__buyStatusTimer) {
        clearInterval(window.__buyStatusTimer);
        window.__buyStatusTimer = null;
      }
      savePayloadUuid(null);
      paymentStarted = false;
      cart = [];
      updateCart();
      hideEndBtn();
      addMessage("bot", t("resetMsg"));
      playVideo("thanks");
    }
  });
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    if (voiceBtn) voiceBtn.style.display = "none";
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = currentLang === "zh" ? "zh-TW" : "en-US";
  recognition.interimResults = false;

  voiceBtn.addEventListener("click", () => {
    recognition.lang = currentLang === "zh" ? "zh-TW" : "en-US";
    recognition.start();
    voiceBtn.classList.add("listening");
  });

  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript.trim();
    voiceBtn.classList.remove("listening");
    handleAiOrderText(text);
  };
  recognition.onerror = () => voiceBtn.classList.remove("listening");
}

if (sendBtn && messageInput) {
  const sendMessage = () => {
    const text = messageInput.value;
    if (text.trim()) {
      handleAiOrderText(text);
      messageInput.value = "";
    }
  };
  sendBtn.addEventListener("click", sendMessage);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  });
}

// --- 啟動邏輯 ---
const startOverlay = document.getElementById("startOverlay");
const startBtn = document.getElementById("startButton");

if (startBtn) {
  startBtn.addEventListener("click", () => {
    startOverlay.classList.add("hidden");

    updateUIText();
    initSpeechRecognition();

    vidIdle.play().catch(() => {});
    addMessage("bot", t("welcomeText"));
    playVideo("welcome");

    // 若重新整理頁面時 localStorage 還有 payload_uuid，可自動續查
    const savedUuid = getSavedPayloadUuid();
    if (savedUuid) {
      pollBuyStatus(savedUuid);
    }
  });
}