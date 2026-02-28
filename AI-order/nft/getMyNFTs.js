// ./getMyNFTs.js
import * as xrpl from "xrpl";
import dotenv from "dotenv";
dotenv.config();

/**
 * 取得指定地址的 NFT 列表
 * @param {string} address - XRPL 帳號地址
 * @returns {Promise<Array>} - NFT 陣列
 */
export default async function getMyNFTs(address) {
  const client = new xrpl.Client(process.env.XRPL_ENDPOINT);
  await client.connect();

  const resp = await client.request({
    command: "account_nfts",
    account: address,
  });

  await client.disconnect();
  return resp.result.account_nfts || [];
}
