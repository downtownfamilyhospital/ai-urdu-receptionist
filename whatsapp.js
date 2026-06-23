// =========================================================
//  whatsapp.js
//  Talks to META's WhatsApp Cloud API (direct, no BSP).
//  This is the cheapest path: no monthly platform fee.
//  (Receiving happens in server.js via the webhook.)
// =========================================================

import axios from "axios";

// Meta gives you a "Phone Number ID" and an access token.
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

const api = axios.create({
  baseURL: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// Send a plain text WhatsApp message back to the patient.
export async function sendText(to, text) {
  try {
    await api.post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
  }
}
