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

// ===== V2: Interactive messages =====

// Welcome menu: intro + 5-service list (WhatsApp list message).
export async function sendWelcomeMenu(to) {
  const body =
    "السلام علیکم 🌸\nمیں زینب ہوں۔\nڈاؤن ٹاؤن فیملی ہسپتال، جی 10 مرکز، اسلام آباد میں خوش آمدید۔\nہم درج ذیل سہولیات فراہم کرتے ہیں:";
  await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: "سروس منتخب کریں",
          sections: [
            {
              title: "ہماری سہولیات",
              rows: [
                { id: "dept_online", title: "👨‍⚕️ آن لائن ڈاکٹر مشورہ" },
                { id: "dept_pharmacy", title: "💊 گھر پر ادویات" },
                { id: "dept_nursing", title: "🏥 گھر پر نرسنگ سروس" },
                { id: "dept_lab", title: "🧪 گھر سے لیب نمونے" },
                { id: "dept_aesthetic", title: "✨ ایستھیٹک اپائنٹمنٹ" },
              ],
            },
          ],
        },
      },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// Reply with a 🏠 ہوم button attached. Falls back to plain text for long replies.
export async function sendTextWithHome(to, text) {
  const t = (text || "").trim();
  if (!t) return;
  if (t.length > 980) {
    // interactive body limit ~1024 chars — send text, then a tiny Home chip
    await sendText(to, t);
    return sendHomeChip(to);
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: t },
          action: { buttons: [{ type: "reply", reply: { id: "home", title: "🏠 ہوم" } }] },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    // Any interactive failure → never lose the reply; send plain text.
    console.error("interactive send failed, falling back to text:", e.response?.data?.error?.message || e.message);
    await sendText(to, t);
  }
}

async function sendHomeChip(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "🌸" },
          action: { buttons: [{ type: "reply", reply: { id: "home", title: "🏠 ہوم" } }] },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { /* non-critical */ }
}
