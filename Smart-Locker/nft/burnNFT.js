const xrpl = require("xrpl")
require("dotenv").config()

async function burnNFT(nftId) {
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233")
  await client.connect()

  const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SECRET)

  const tx = {
    TransactionType: "NFTokenBurn",
    Account: wallet.classicAddress,
    NFTokenID: nftId
  }

  const prepared = await client.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await client.submitAndWait(signed.tx_blob)

  const txResult = result.result.meta.TransactionResult
  if (txResult !== "tesSUCCESS") {
    throw new Error("NFT 銷毀失敗：" + txResult)
  }

  await client.disconnect()
  return result
}

module.exports = burnNFT
