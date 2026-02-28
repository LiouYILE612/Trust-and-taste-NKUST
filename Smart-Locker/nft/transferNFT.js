const xrpl = require("xrpl")
require("dotenv").config()

async function transferNFT(nftId, destination) {
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233")
  await client.connect()

  const issuerWallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SECRET)

  const offerTx = {
    TransactionType: "NFTokenCreateOffer",
    Account: issuerWallet.classicAddress,
    NFTokenID: nftId,
    Destination: destination,
    Amount: "0",        // ✅ 這是重點，加上它就不會錯
    Flags: 1            // ✅ Sell offer
  }

  const prepared = await client.autofill(offerTx)
  const signed = issuerWallet.sign(prepared)
  const result = await client.submitAndWait(signed.tx_blob)

  if (result.result.meta.TransactionResult !== "tesSUCCESS") {
    throw new Error("❌ 建立 NFT Offer 失敗：" + result.result.meta.TransactionResult)
  }

  const offerId = result.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === "NFTokenOffer")
    ?.CreatedNode?.LedgerIndex

  if (!offerId) throw new Error("❌ 找不到 NFT Offer ID")

  console.log("✅ NFT Offer 建立成功，ID：", offerId)
  console.log("📬 請收件人至 Xaman App 接收 NFT：", destination)

  await client.disconnect()
  return { offerId }
}

module.exports = transferNFT
