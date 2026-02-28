# \# 🔐 Trust-and-Taste

# 

# > \*\*MPT Issuance · AI-Powered Ordering · Smart Locker Redemption\*\*

# > Built on XRPL · Powered by Xaman (XUMM) · AI by OpenAI

# 

# \[!\[Node.js](https://img.shields.io/badge/Node.js-ESM%20%2F%20CJS-green?logo=node.js)](https://nodejs.org)

# \[!\[XRPL](https://img.shields.io/badge/XRPL-Testnet%20%2F%20Mainnet-blue?logo=xrp)](https://xrpl.org)

# \[!\[License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

# 

# ---

# 

# \## Overview

# 

# \*\*Trust-and-Taste\*\* is a full-stack Web3 commerce demonstration integrating three interconnected systems on the XRP Ledger:

# 

# | Module | Description |

# |--------|-------------|

# | \[\*\*Bank Issuer MPT System\*\*](#1-bank-issuer-mpt-system) | Issue, authorize, freeze, and clawback MPTokens |

# | \[\*\*AI Order \& MPT Payment\*\*](#2-ai-order--mpt-payment) | AI-driven ordering with on-chain multi-currency payment and NFT receipts |

# | \[\*\*Smart Locker\*\*](#3-smart-locker-system) | NFT-burn-based physical locker redemption via Xaman |

# 

# ---

# 

# \## Architecture

# 

# ```

# ┌──────────────────────────────────────────────────────┐

# │                    XRPL (Testnet / Mainnet)           │

# │  MPTokenIssuance ──► MPT Transfer ──► NFT Mint/Burn  │

# └────────────┬─────────────────────────────────────────┘

# &nbsp;            │ xrpl SDK

# &nbsp;  ┌──────────▼──────────────────────────────────┐

# &nbsp;  │           Node.js Backend Services          │

# &nbsp;  │  ┌────────────┐ ┌──────────┐ ┌───────────┐ │

# &nbsp;  │  │ MPT Issuer │ │ AI Order │ │  Locker   │ │

# &nbsp;  │  │  :3000     │ │  :3000   │ │  :3060    │ │

# &nbsp;  │  └────────────┘ └──────────┘ └───────────┘ │

# &nbsp;  └──────────────────────────────────────────────┘

# &nbsp;            │

# &nbsp;  ┌──────────▼──────────────────────────────────┐

# &nbsp;  │     Xaman (XUMM) Wallet  ·  OpenAI API      │

# &nbsp;  │     Pinata IPFS  ·  SQLite                   │

# &nbsp;  └──────────────────────────────────────────────┘

# ```

# 

# ---

# 

# \## Project Structure

# 

# ```

# trust-and-taste/

# │

# ├── mpt-issuer/                  # Module 1: Bank Issuer MPT System

# │   ├── server.mjs               # Express server (ESM)

# │   ├── app.js                   # Frontend static JS

# │   ├── data.sqlite              # SQLite persistence (auto-created)

# │   ├── .env                     # Environment config

# │   └── package.json

# │

# ├── ai-order/                    # Module 2: AI Order \& MPT Payment

# │   ├── server.js                # Main backend (ESM)

# │   ├── main.js                  # Frontend ordering logic

# │   ├── mintNFT.js               # Mint NFT on XRPL

# │   ├── transferNFT.js           # NFT Sell Offer (0 XRP)

# │   ├── burnNFT.js               # NFT burn utility

# │   ├── getMyNFTs.js             # Query NFTs by address

# │   ├── uploadIPFS.js            # Pinata IPFS uploader

# │   ├── .env

# │   └── package.json

# │

# └── smart-locker/                # Module 3: Smart Locker System

# &nbsp;   ├── server.js                # Main backend (CJS)

# &nbsp;   ├── app.js                   # Frontend locker UI logic

# &nbsp;   ├── burnNFT.js               # Execute NFTokenBurn

# &nbsp;   ├── mintNFT.js               # NFT minting

# &nbsp;   ├── transferNFT.js           # NFT transfer offer

# &nbsp;   ├── uploadIPFS.js            # Pinata IPFS uploader

# &nbsp;   ├── .env

# &nbsp;   └── package.json

# ```

# 

# ---

# 

# \## 1. Bank Issuer MPT System

# 

# \### Features

# 

# \- \*\*MPToken Issuance\*\* — Create `MPTokenIssuance` on XRPL with configurable `AssetScale`, `TransferFee`, and `MaxAmount`

# \- \*\*Holder Authorization (Allow-list)\*\* — `tfMPTRequireAuth` mode; issuer explicitly approves each holder

# \- \*\*MPT Transfer\*\* — Issuer-initiated direct MPT transfers to target accounts

# \- \*\*Clawback\*\* — Recover MPT from any holder account

# \- \*\*Account Freeze / Unfreeze\*\* — Restrict or restore circulation via `MPTokenIssuanceSet`

# \- \*\*Blacklist Policy\*\* — Automatic clawback triggered for blacklisted accounts

# \- \*\*Monitoring Dashboard\*\* — `/api/monitor` endpoint with recent operation logs

# \- \*\*SQLite Persistence\*\* — All records stored in `data.sqlite` (WAL mode)

# 

# \### Tech Stack

# 

# | Component | Technology |

# |-----------|-----------|

# | Runtime | Node.js (ESM) |

# | Framework | Express |

# | XRPL SDK | `xrpl` |

# | Wallet | `xumm-sdk` (Xaman) |

# | Database | `better-sqlite3` |

# | Frontend | Vanilla HTML + JS |

# 

# \### Environment Variables

# 

# ```env

# PORT=3000

# BASE\_URL=http://localhost:3000

# 

# XRPL\_WS=wss://s.altnet.rippletest.net:51233

# 

# KFD\_ISSUER\_SEED=sIssuerSeed...

# KFD\_ISSUER\_ADDRESS=rIssuerAddress...

# 

# XUMM\_API\_KEY=your-xumm-api-key

# XUMM\_API\_SECRET=your-xumm-api-secret

# 

# \# Optional

# RLUSD\_ISSUER=rRlusdAddress

# ```

# 

# > ⚠️ \*\*Never commit real credentials.\*\* Use `.env.example` for templates.

# 

# \### Quick Start

# 

# ```bash

# cd mpt-issuer

# npm install

# npm start

# \# → http://localhost:3000

# ```

# 

# \### API Reference

# 

# | Method | Endpoint | Description |

# |--------|----------|-------------|

# | `POST` | `/api/issue` | Create a new MPTokenIssuance |

# | `POST` | `/api/authorize` | Authorize a holder account |

# | `POST` | `/api/transfer` | Transfer MPT to an account |

# | `POST` | `/api/clawback` | Clawback MPT from a holder |

# | `POST` | `/api/freeze` | Freeze a holder's MPT |

# | `POST` | `/api/unfreeze` | Unfreeze a holder's MPT |

# | `GET`  | `/api/monitor` | View recent operation logs |

# 

# ---

# 

# \## 2. AI Order \& MPT Payment

# 

# \### Features

# 

# \- \*\*AI Ordering Conversation\*\* — OpenAI-powered NLU for customer ordering; supports Chinese \& English

# \- \*\*Multi-Currency Payment\*\* — Xumm Payload integration supporting MPT, XRP, and RLUSD

# \- \*\*NFT Receipt Minting\*\* — Post-payment: metadata → IPFS (Pinata) → NFT mint → transfer offer to buyer

# \- \*\*Virtual Barista UI\*\* — Interactive idle/action video frontend

# \- \*\*RLUSD TrustLine Management\*\* — Xumm Payload helper for merchant trust line setup

# 

# \### Tech Stack

# 

# | Component | Technology |

# |-----------|-----------|

# | Runtime | Node.js (ESM) |

# | Framework | Express |

# | AI | OpenAI API |

# | XRPL SDK | `xrpl` |

# | Wallet | `xumm-sdk` (Xaman) |

# | IPFS | Pinata |

# | Frontend | Vanilla HTML + JS |

# 

# \### Environment Variables

# 

# ```env

# BASE\_URL=https://your-domain-or-ngrok

# 

# OPENAI\_API\_KEY=sk-...

# 

# STORE\_ADDRESS=rStoreWalletAddress...

# ISSUER\_SECRET=sIssuerSeed...

# ISSUER\_ADDRESS=rIssuerAddress...

# 

# XUMM\_API\_KEY=your-xumm-api-key

# XUMM\_API\_SECRET=your-xumm-api-secret

# 

# PINATA\_JWT=your-pinata-jwt

# 

# KFD\_MPT\_ISSUANCE\_ID=00E253...

# 

# RLUSD\_ISSUER=rRLUSDIssuerAddress...

# RLUSD\_CURRENCY=RLUSD

# ```

# 

# \### Quick Start

# 

# ```bash

# cd ai-order

# npm install

# npm run dev

# \# → http://localhost:3000

# ```

# 

# \### Payment Flow

# 

# ```

# User (AI Chat)

# &nbsp; │  Place order via natural language

# &nbsp; ▼

# Select Payment Method (MPT / XRP / RLUSD)

# &nbsp; │

# &nbsp; ▼

# Backend creates Xumm Payload

# &nbsp; │

# &nbsp; ▼

# User scans QR → Signs via XAMAN

# &nbsp; │

# &nbsp; ▼

# Backend verifies on-chain transaction

# &nbsp; │

# &nbsp; ▼

# Upload receipt image → Pinata IPFS

# &nbsp; │

# &nbsp; ▼

# Mint NFT (IPFS URI → XRPL)

# &nbsp; │

# &nbsp; ▼

# Create NFT Sell Offer (0 XRP)

# &nbsp; │

# &nbsp; ▼

# Consumer receives NFT receipt in XAMAN ✅

# ```

# 

# \### API Reference

# 

# | Method | Endpoint | Description |

# |--------|----------|-------------|

# | `POST` | `/api/chat` | Send message to AI ordering agent |

# | `POST` | `/api/checkout` | Create Xumm payment payload |

# | `GET`  | `/api/payload/:id` | Poll Xumm payload status |

# | `POST` | `/api/verify` | Verify on-chain transaction |

# | `POST` | `/api/mint-receipt` | Mint NFT receipt and create transfer offer |

# | `POST` | `/api/trustline` | Generate RLUSD trustline payload for merchant |

# 

# ---

# 

# \## 3. Smart Locker System

# 

# \### Features

# 

# \- \*\*Xaman Sign-In\*\* — QR-code login to retrieve the user's XRPL account

# \- \*\*NFT List Query\*\* — Filter NFTs by issuer address; resolve IPFS metadata and images

# \- \*\*NFT Burn Redemption\*\* — User signs `NFTokenBurn`; backend confirms on-chain and triggers unlock

# \- \*\*Virtual Locker UI\*\* — LED status indicator and door-opening animation

# \- \*\*IPFS Proxy\*\* — Server-side IPFS gateway proxy to avoid browser CORS issues

# 

# \### Tech Stack

# 

# | Component | Technology |

# |-----------|-----------|

# | Runtime | Node.js (CJS) |

# | Framework | Express |

# | XRPL SDK | `xrpl` |

# | Wallet | `xumm-sdk` (Xaman) |

# | IPFS | Pinata |

# | Frontend | Vanilla HTML + JS |

# 

# \### Environment Variables

# 

# ```env

# PORT=3060

# BASE\_URL=https://your-ngrok-or-domain

# 

# XAMAN\_API\_KEY=your-xaman-api-key

# XAMAN\_API\_SECRET=your-xaman-api-secret

# 

# XRPL\_WSS=wss://s.altnet.rippletest.net:51233

# ISSUER\_ADDRESS=rIssuerAddress...

# ISSUER\_SECRET=sIssuerSeed...

# 

# PINATA\_JWT=your-pinata-jwt

# 

# \# Optional: custom IPFS gateways (comma-separated)

# IPFS\_GATEWAYS=https://nftstorage.link/ipfs/,https://ipfs.io/ipfs/

# ```

# 

# \### Quick Start

# 

# ```bash

# cd smart-locker

# npm install

# npm start

# \# → http://localhost:3060

# ```

# 

# \### Redemption Flow

# 

# ```

# User scans QR code (Xaman SignIn)

# &nbsp; │

# &nbsp; ▼

# Backend returns XRPL account

# &nbsp; │

# &nbsp; ▼

# Query account NFT list (filtered by ISSUER\_ADDRESS)

# &nbsp; │

# &nbsp; ▼

# Resolve IPFS metadata \& images

# &nbsp; │

# &nbsp; ▼

# User selects NFT → Signs NFTokenBurn via XAMAN

# &nbsp; │

# &nbsp; ▼

# Backend confirms on-chain burn

# &nbsp; │

# &nbsp; ▼

# Locker unlocks ✅  (LED green + door-opening animation)

# ```

# 

# \### API Reference

# 

# | Method | Endpoint | Description |

# |--------|----------|-------------|

# | `POST` | `/api/signin` | Create Xaman sign-in payload |

# | `GET`  | `/api/signin/:uuid` | Poll sign-in status |

# | `GET`  | `/api/nfts/:address` | Get NFTs held by address (filtered by issuer) |

# | `POST` | `/api/burn` | Create NFTokenBurn payload |

# | `GET`  | `/api/burn/:uuid` | Poll burn status and trigger unlock |

# | `GET`  | `/api/ipfs/:cid` | Proxy IPFS content (avoids CORS) |

# 

# ---

# 

# \## Security Notes

# 

# \- \*\*Never commit `.env` files\*\* — add them to `.gitignore`

# \- Use environment-specific credentials for testnet vs. mainnet

# \- Rotate Xumm API keys regularly

# \- All issuer seed phrases (`sXXX...`) must be stored securely; consider HSM or secrets management in production

# 

# ---

# 

# \## Contributing

# 

# 1\. Fork the repository

# 2\. Create a feature branch: `git checkout -b feature/my-feature`

# 3\. Commit your changes: `git commit -m 'feat: add my feature'`

# 4\. Push to the branch: `git push origin feature/my-feature`

# 5\. Open a Pull Request

# 

# ---

# 

# \## License

# 

# MIT © Trust-and-Taste Contributors

