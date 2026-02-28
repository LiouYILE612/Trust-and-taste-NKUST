// nft/uploadIPFS.js
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

/**
 * 📤 上傳圖片與 metadata 至 IPFS（Pinata）
 * @param {string} filePath - 圖片檔案路徑
 * @param {string} name - NFT 名稱
 * @param {string} description - NFT 描述
 * @param {object} extraMeta - 額外 metadata 欄位（可選）
 * @returns {Promise<{ metadataURI: string, imageURL: string }>}
 */
export default async function uploadToIPFS(filePath, name, description, extraMeta = {}) {
  // 1️⃣ 上傳圖片檔案到 Pinata
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const metadata = JSON.stringify({ name });
  form.append("pinataMetadata", metadata);

  const options = JSON.stringify({ cidVersion: 1 });
  form.append("pinataOptions", options);

  const response = await axios.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    form,
    {
      maxBodyLength: Infinity,
      headers: {
        ...form.getHeaders(),
        Authorization: process.env.PINATA_JWT,
      },
    }
  );

  const imageCid = response.data.IpfsHash;
  const imageURL = `https://gateway.pinata.cloud/ipfs/${imageCid}`;

  // 2️⃣ 建立 metadata JSON 並上傳
  const metadataJson = {
    name,
    description,
    image: imageURL,
    ...extraMeta,
  };

  const jsonRes = await axios.post(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    metadataJson,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: process.env.PINATA_JWT,
      },
    }
  );

  const metadataCid = jsonRes.data.IpfsHash;
  const metadataURI = `ipfs://${metadataCid}`;

  console.log("✅ 已上傳至 IPFS：", metadataURI);
  return { metadataURI, imageURL };
}
