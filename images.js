// =========================================================
//  images.js  — turn a patient's WhatsApp photo into a
//  PUBLIC, directly-viewable link via GOOGLE DRIVE.
//  Uses the SAME robot (service account) already used for
//  Sheets. Uploads the image to a Drive folder, makes it
//  public, returns a direct-view link for the manager.
// =========================================================

import axios from "axios";
import { google } from "googleapis";
import { Readable } from "stream";

const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || ""; // optional folder

function getDrive() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/drive"]
  );
  return google.drive({ version: "v3", auth });
}

// Download an image (by WhatsApp media id) from Meta.
async function downloadWhatsAppImage(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const mediaUrl = meta.data.url;
  const mime = meta.data.mime_type || "image/jpeg";
  const img = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { buffer: Buffer.from(img.data), mime };
}

// Main: WhatsApp image media id → public direct-view Drive link (or "").
export async function imageToPublicLink(mediaId) {
  try {
    const drive = getDrive();
    const { buffer, mime } = await downloadWhatsAppImage(mediaId);
    const ext = mime.includes("png") ? "png" : "jpg";
    const filename = `rx_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;

    // Upload the file to Drive
    const fileMeta = { name: filename };
    if (DRIVE_FOLDER_ID) fileMeta.parents = [DRIVE_FOLDER_ID];

    const created = await drive.files.create({
      requestBody: fileMeta,
      media: { mimeType: mime, body: Readable.from(buffer) },
      fields: "id",
    });
    const fileId = created.data.id;

    // Make it public (anyone with the link can view)
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    // Direct-view link (opens the photo itself)
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  } catch (e) {
    console.error("imageToPublicLink (Drive) error:", e.response?.data || e.message);
    return "";
  }
}
