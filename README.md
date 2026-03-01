# Trust-and-Taste — Smart Locker

> NFT Redemption × Xaman Login × Virtual Smart Locker

A smart ordering and redemption platform integrating **XRPL NFT**, **Xaman (XUMM) Wallet**, and **IPFS**. Customers can place orders via an AI chat interface, receive an NFT as a meal voucher, and scan to burn the NFT to unlock the locker and pick up their order.

---

## Table of Contents

- [Project Architecture](#project-architecture)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [NFT Lifecycle](#nft-lifecycle)
- [Module Reference](#module-reference)
- [Environment Setup](#environment-setup)
- [Installation & Launch](#installation--launch)
- [API Endpoints](#api-endpoints)
- [Database Schema (MPT System)](#database-schema-mpt-system)
- [Security](#security)
- [Prerequisites](#prerequisites)

---

## Project Architecture

This project consists of three subsystems:

| Subsystem | Description |
|-----------|-------------|
| **MPT Issuer** | XRPL-based Multi-Purpose Token issuance and management backend, integrated with the Xumm payment flow |
| **AI Cafe** | NFT meal redemption system with AI ordering interface, voice input, and multi-payment support |
| **Smart Locker** | Virtual smart locker that automatically unlocks and plays a door-open animation after NFT burn |

```
├── AI-order         
├── MPT-Issuer             
├── Smart-Locker              

```

---

## Features

- **AI Chat Ordering**: Multilingual (Chinese / English) virtual barista with voice input support
- **Virtual Bar Animation**: Idle / Action video switching for an immersive ordering experience
- **Multi-Payment Integration**: Credit card, MPT, and RLUSD payment options
- **NFT Minting**: Automatically mints a meal NFT on XRPL Testnet upon order completion
- **Permanent IPFS Storage**: NFT images and metadata uploaded to Pinata
- **Xaman QR Login**: Wallet SignIn via XUMM / Xaman App
- **NFT Redemption**: Scan to sign NFTokenBurn; backend confirms on-chain before triggering locker unlock
- **Smart Locker UI**: Plays door-open animation and turns LED status light green after successful NFT burn
- **MPT Issuance Management**: Full MPT lifecycle — authorization, transfer, clawback, account locking
- **Swap Flow**: Users pay in XRP or RLUSD; the system automatically completes authorization and MPT delivery

---

## Tech Stack

| Category | Technology |
|----------|------------|
| Frontend | Vanilla JS, HTML5, CSS3 |
| Backend | Node.js, Express |
| Blockchain | XRPL (`xrpl.js`), Xaman SDK (`xumm-sdk`) |
| NFT Storage | IPFS via Pinata |
| Wallet | Xaman (XUMM) App |
| Database | SQLite (`better-sqlite3`, WAL mode) |
| Network | XRPL Testnet (`s.altnet.rippletest.net`) |

---

## NFT Lifecycle

```
Order placed
   ↓
uploadIPFS.js — Upload image + metadata to Pinata
   ↓
mintNFT.js — Mint NFT on XRPL (URI points to IPFS)
   ↓
transferNFT.js — Create 0 XRP Sell Offer and send to customer
   ↓
Customer scans to accept NFT (Xaman App)
   ↓
Customer visits redemption page, signs NFTokenBurn via Xaman
   ↓
burnNFT.js / server.js detects successful on-chain burn
   ↓
Locker unlock animation triggered ✅  Order picked up
```

**Smart Locker Redemption Flow:**

```
User scans QR Code to log in (Xaman SignIn)
  → Query account NFT list (filtered by issuer)
  → Select NFT → Sign NFTokenBurn
  → Backend confirms on-chain destruction
  → Locker unlocked ✅ (LED turns green + door-open animation)
```

---

## Module Reference

| Module / File | Description |
|---------------|-------------|
| `server.js` | Main backend: Xaman login, NFT query, burn redemption, IPFS proxy |
| `app.js` | Frontend logic: login polling, NFT selection, burn signing, locker animation |
| `nft/mintNFT.js` | Executes XRPL `NFTokenMint` transaction |
| `nft/burnNFT.js` | Executes `NFTokenBurn` transaction |
| `nft/transferNFT.js` | Creates NFT Sell Offer (0 XRP) to transfer to customer |
| `nft/uploadIPFS.js` | Uploads images and metadata to Pinata |
| `nft/getMyNFTs.js` | Queries NFT list for a given account |

**Shared frontend utilities (`app.js`):**

- `api(path, method, body)` — Wrapped fetch call
- `pollPayload(uuid, onUpdate)` — Poll Xumm Payload until resolved
- `setStatus(el, kind, text)` — Update UI status label
- `pretty(x)` — JSON pretty-print output

---

## Environment Setup

Copy `_env` to `.env` and fill in the following fields:

```env
# Xaman (XUMM) API
XAMAN_API_KEY=your_xaman_api_key
XAMAN_API_SECRET=your_xaman_api_secret

# XRPL Configuration
XRPL_ENDPOINT=wss://s.altnet.rippletest.net:51233
XRPL_WSS=wss://s.altnet.rippletest.net:51233
ISSUER_ADDRESS=your_issuer_xrpl_address
ISSUER_SECRET=your_issuer_wallet_seed

# Pinata IPFS
PINATA_JWT=your_pinata_jwt_token

# Server Configuration
PORT=3060
BASE_URL=http://localhost:3060

# IPFS Gateway (optional, comma-separated)
IPFS_GATEWAYS=https://nftstorage.link/ipfs/,https://ipfs.io/ipfs/,https://cloudflare-ipfs.com/ipfs/

# ── MPT Seed System only ──
XRPL_WS=wss://s1.ripple.com
KFD_ISSUER_SEED=sXXXXXXXXXXXXXXXXXXXXXXXXXXX
KFD_ISSUER_ADDRESS=rXXXXXXXXXXXXXXXXXXXXXXXXXXX
XUMM_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
XUMM_API_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
RLUSD_ISSUER=rXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

> ⚠️ **Security Notice**: Never commit `.env` to version control. `ISSUER_SECRET` / `KFD_ISSUER_SEED` are wallet private keys — keep them safe.

---

## Installation & Launch

```bash
# 1. Install dependencies
npm install

# 2. Start server (Smart Locker / AI Cafe)
node server.js
# Runs at http://localhost:3060 by default

# Start MPT Seed System
npm start
# Runs at http://localhost:3000 by default
```

---

## API Endpoints

### Smart Locker / AI Cafe

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ping` | Health check |
| `GET` | `/api/login` | Create Xaman SignIn Payload and get QR Code |
| `GET` | `/api/login/status?uuid=` | Poll login status, retrieve wallet address |
| `GET` | `/api/nfts?uuid=` | List NFTs issued by the issuer for the logged-in account |
| `GET` | `/api/resolve-uri?uri=` | Backend proxy to resolve NFT URI (avoids browser CORS) |
| `POST` | `/api/redeem` | Create NFTokenBurn Payload and get redemption QR Code |
| `GET` | `/api/redeem/status?uuid=` | Poll burn status; trigger locker unlock on success |
| `POST` | `/api/logout` | Clear session |

### MPT Seed System — Issuance Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/kfd/create` | Create a new MPTokenIssuance |
| `POST` | `/api/kfd/authorize` | Authorize a holder to hold MPT |
| `POST` | `/api/kfd/send` | Issuer sends MPT to a specified address |
| `POST` | `/api/kfd/clawback` | Clawback MPT from a holder |
| `POST` | `/api/kfd/lock` | Lock a holder account |
| `POST` | `/api/kfd/unlock` | Unlock a holder account |

### MPT Seed System — Swap & Query

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/kfd/swap-init` | Create Xumm Payload for XRP or RLUSD payment |
| `GET` | `/api/payload/:uuid` | Poll Payload status; auto-send MPT after payment confirmed |
| `GET` | `/api/kfd/status` | Get current Issuance config and on-chain data |
| `GET` | `/api/kfd/account-status/:holder` | Query lock and clawback status for a specific holder |
| `GET` | `/api/kfd/account-actions` | List all lock and clawback records |
| `GET` | `/api/mpt/info` | Query on-chain MPTokenIssuance details |
| `GET` | `/api/mpt/account?account=rXXX` | Query MPT balance for a specific account |
| `GET` | `/api/check-mpt` | Quick check of Issuance flags |
| `GET` | `/api/monitor` | Retrieve audit data (latest 50 records each) |
| `GET` | `/api/debug/db` | Show database file path (debug only) |

---

## Database Schema (MPT System)

The SQLite database (`data.sqlite`) contains the following tables:

| Table | Description |
|-------|-------------|
| `kv` | Key-value store for system config and Issuance state |
| `xumm_payloads` | Xumm Payload creation and resolution records |
| `authorizations` | Audit log for holder authorization operations |
| `transfers` | Audit log for MPT transfers |
| `clawbacks` | Audit log for MPT clawbacks |
| `account_locks` | Audit log for account lock / unlock operations |

---

## Security

- **SSRF Protection**: `/api/resolve-uri` restricts outbound requests to a whitelist of trusted hosts (Pinata, public IPFS gateways, Cloudflare, etc.)
- **On-Chain NFT Verification**: Burn success is determined by querying `account_nfts` on-chain, not solely by the `signed` status returned by Xaman
- **In-Memory Session**: Sessions are stored in memory and cleared on server restart — no persistence risk
- **MPT Policy Controls**: Supports auto-lock after swap, auto-unlock, and automatic clawback for blacklisted accounts

---

## Prerequisites

- **Node.js** v18+ (v20 LTS recommended)
- **Xaman Developer Account**: [xumm.readme.io](https://xumm.readme.io)
- **Pinata Account**: [pinata.cloud](https://pinata.cloud)
- **XRPL Testnet Wallet**: [xrpl.org/xrp-testnet-faucet.html](https://xrpl.org/xrp-testnet-faucet.html)

---

## Team 
1.Yu-Hung Cheng
2.Kelly Huang
3.Ho-Feng Chiu
4.YI-LE,LIOU
5.Dr. Wei-Chih,HSU
6.Dr. Echo Huang

