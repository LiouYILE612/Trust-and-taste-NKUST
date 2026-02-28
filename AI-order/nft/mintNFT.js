// nft/mintNFT.js
import * as xrpl from "xrpl";
import dotenv from "dotenv";
dotenv.config();

/**
 * 將各種來源（字串 / Pinata 物件 / {uri,url}）統一轉成字串 URI
 */
function normalizeUri(input) {
  if (!input) throw new Error("缺少 metadata URI 輸入");
  if (typeof input === "string") return input.trim();

  if (input.IpfsHash || input.ipfsHash) {
    const hash = input.IpfsHash || input.ipfsHash;
    return `ipfs://${hash}`;
  }
  if (typeof input.uri === "string") return input.uri.trim();
  if (typeof input.url === "string") return input.url.trim();
  if (input.data?.IpfsHash || input.data?.ipfsHash) {
    const hash = input.data.IpfsHash || input.data.ipfsHash;
    return `ipfs://${hash}`;
  }
  throw new Error("提供的物件裡沒有可用的 URI 字串");
}

/**
 * 🪙 Mint NFT on XRPL
 * @param {string} recipientAddress - 目前未直接使用（XRPL NFT 需先鑄在自己名下，再轉移）
 * @param {string|object} ipfsUri - Pinata 回傳或 IPFS URI
 * @returns {Promise<{ result: object, nft_id: string }>}
 */
export default async function mintNFT(recipientAddress, ipfsUri) {
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();

  const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SECRET);

  // ✅ 轉成字串 URI
  const uriString = normalizeUri(ipfsUri);

  // 健檢 URI 長度
  if (Buffer.byteLength(uriString, "utf8") > 256) {
    throw new Error("URI 太長（建議 ≤ 256 bytes）");
  }

  const mintTx = {
    TransactionType: "NFTokenMint",
    Account: wallet.classicAddress,
    URI: xrpl.convertStringToHex(uriString),
    Flags: xrpl.NFTokenMintFlags.tfTransferable,
    NFTokenTaxon: 0,
  };

  const prepared = await client.autofill(mintTx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  await client.disconnect();

  const meta = result.result.meta;
  if (meta.TransactionResult !== "tesSUCCESS") {
    throw new Error(`❌ NFT 鑄造失敗：${meta.TransactionResult}`);
  }

  // 取得 NFT ID
  const nftId = meta.nftoken_id;
  if (!nftId) {
    throw new Error("❌ NFT 鑄造成功但未取得 nftoken_id，可改為從 AffectedNodes 解析");
  }

  console.log("✅ NFT Minted:", nftId);
  return { result, nft_id: nftId };
}
