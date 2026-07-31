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

// ===== V2.7/V2.9: tutorial video =====
// Sending video by public LINK is fragile: Meta's fetcher must be able to
// reach the URL from the public internet, and any redirect, cold start or
// slow first byte makes it give up silently. The reliable path is to UPLOAD
// the file once to WhatsApp's own media store, get a media_id, and send that.
// We cache the id (see database.js) and only re-upload when it goes stale.

// Upload a video to WhatsApp's media store → returns media_id or "".
// Accepts either a local file path OR a raw Buffer (browser upload).
export async function uploadVideoToWhatsApp(fileOrBuffer) {
  try {
    let buf;
    if (Buffer.isBuffer(fileOrBuffer)) {
      buf = fileOrBuffer;
    } else {
      const { readFile } = await import("node:fs/promises");
      buf = await readFile(fileOrBuffer);
    }
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "video/mp4");
    form.append("file", new Blob([buf], { type: "video/mp4" }), "tutorial-video.mp4");

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
      { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: form }
    );
    const data = await res.json();
    if (!res.ok || !data.id) {
      console.error("❌ video upload failed:", JSON.stringify(data));
      return "";
    }
    console.log(`✅ tutorial video uploaded to WhatsApp — media_id ${data.id}`);
    return data.id;
  } catch (e) {
    console.error("❌ video upload exception:", e.message);
    return "";
  }
}

// Send a video by media_id (preferred) — returns true on success.
export async function sendVideoById(to, mediaId, caption = "") {
  try {
    const video = { id: mediaId };
    if (caption) video.caption = caption; // omit entirely when empty — bare video
    await api.post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "video",
      video,
    });
    return true;
  } catch (err) {
    console.error("❌ sendVideoById error:", JSON.stringify(err.response?.data || err.message));
    return false;
  }
}

// Send a video by public link (fallback) — returns true on success.
export async function sendVideoByLink(to, videoUrl, caption = "") {
  try {
    const video = { link: videoUrl };
    if (caption) video.caption = caption;
    await api.post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "video",
      video,
    });
    return true;
  } catch (err) {
    console.error("❌ sendVideoByLink error:", JSON.stringify(err.response?.data || err.message));
    return false;
  }
}

// ===== V2: Interactive messages =====

// Language selection — the very first message to any new patient.
export async function sendLanguageSelect(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "🌸 *Downtown Family Hospital* میں خوش آمدید!\nWelcome! I'm *Zainab*, your personal assistant — here to help you 24/7. 😊\n\nPlease select your preferred language 👇\nبراہ کرم اپنی پسندیدہ زبان منتخب کریں 👇" },
          action: { buttons: [
            { type: "reply", reply: { id: "lang_ur", title: "اردو" } },
            { type: "reply", reply: { id: "lang_en", title: "English" } },
          ] },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    await sendText(to, "Please reply: Urdu or English\nبراہ کرم لکھیں: اردو یا English");
  }
}

// Single approved welcome message (per owner's instruction):
// no repeated salam, no self-introduction — thank + one line about DFH + menu.
const WELCOME_UR = [
  "ہم سے رابطہ کرنے کا شکریہ! 🌸\n*ڈاؤن ٹاؤن فیملی ہسپتال* (www.dfh.com.pk) جی ٹین مرکز، اسلام آباد میں واقع ایک رجسٹرڈ ہیلتھ کیئر ادارہ ہے — جو ہسپتال میں معیاری طبی خدمات کے ساتھ ساتھ اب آن لائن اور آپ کی دہلیز پر بھی صحت کی سہولیات فراہم کرتا ہے۔\n\nبراہ کرم جاری رکھنے کے لیے نیچے دی گئی سروسز میں سے ایک منتخب کریں:",
];
const WELCOME_EN = [
  "Thank you for contacting us. 🌸\n*Downtown Family Hospital* (www.dfh.com.pk) is a registered healthcare setup located at G-10 Markaz, Islamabad — providing quality medical services on site, and now also offering healthcare services online and at your doorstep.\n\nPlease select one of the following services to continue:",
];

// Welcome menu: fixed message + 6-service list.
export async function sendWelcomeMenu(to, lang = "ur", variant = 1) {
  const texts = lang === "en" ? WELCOME_EN : WELCOME_UR;
  const body = texts[0]; // always the same approved message
  const rows = lang === "en" ? [
    { id: "dept_online", title: "👨‍⚕️ Online Doctor" },
    { id: "dept_pharmacy", title: "Medicine Delivery (24/7)", description: "💊 Open 24 hours, 7 days" },
    { id: "dept_nursing", title: "🏥 Home Nursing" },
    { id: "dept_lab", title: "🧪 Lab Home Sampling" },
    { id: "dept_aesthetic", title: "✨ Aesthetic Appointment" },
    { id: "dept_physio", title: "💪 Home Physiotherapy" },
  ] : [
    { id: "dept_online", title: "👨‍⚕️ آن لائن ڈاکٹر مشورہ" },
    { id: "dept_pharmacy", title: "💊 گھر پر ادویات (24/7)", description: "ہر وقت دستیاب — چوبیس گھنٹے" },
    { id: "dept_nursing", title: "🏥 گھر پر نرسنگ سروس" },
    { id: "dept_lab", title: "🧪 گھر سے لیب نمونے" },
    { id: "dept_aesthetic", title: "✨ ایستھیٹک اپائنٹمنٹ" },
    { id: "dept_physio", title: "💪 ہوم فزیوتھراپی" },
  ];
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: { button: lang === "en" ? "Select a service" : "سروس منتخب کریں",
            sections: [{ title: lang === "en" ? "Our Services" : "ہماری سہولیات", rows }] },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("welcome menu failed, falling back:", e.response?.data?.error?.message || e.message);
    await sendText(to, body + (lang === "en"
      ? "\n\n1. Online Doctor  2. Medicine Delivery (24/7)  3. Home Nursing  4. Lab Sampling  5. Aesthetic  6. Physiotherapy"
      : "\n\n1. آن لائن ڈاکٹر  2. ادویات (24/7)  3. نرسنگ  4. لیب  5. ایستھیٹک  6. فزیوتھراپی"));
  }
}

// ===== WhatsApp Flows scaffold (activates when Meta Flow IDs are configured) =====
// Set env WA_FLOWS='{"online":"<flow_id>","pharmacy":"...","lab":"...","nursing":"...","aesthetic":"...","physio":"..."}'
export function flowsConfigured() {
  try { return Object.keys(JSON.parse(process.env.WA_FLOWS || "{}")).length > 0; } catch { return false; }
}
export async function sendFlow(to, dept, lang = "ur") {
  const flows = JSON.parse(process.env.WA_FLOWS || "{}");
  const flowId = flows[dept];
  if (!flowId) return false;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: lang === "en" ? "Please fill this short form 🌸" : "براہ کرم یہ مختصر فارم مکمل کریں 🌸" },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_id: flowId,
              flow_cta: lang === "en" ? "Open Form" : "فارم کھولیں",
              flow_action: "navigate",
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    return true;
  } catch (e) {
    console.error("flow send failed (falling back to text form):", e.response?.data?.error?.message || e.message);
    return false;
  }
}

// Reply with a 🏠 ہوم button// Reply with a 🏠 ہوم button attached. Falls back to plain text for long replies.
export async function sendTextWithHome(to, text, lang = "ur") {
  const t = (text || "").trim();
  if (!t) return;
  if (t.length > 980) {
    // interactive body limit ~1024 chars — send text, then a tiny Home chip
    await sendText(to, t);
    return sendHomeChip(to, lang);
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
          action: { buttons: [{ type: "reply", reply: { id: "home", title: lang === "en" ? "🏠 Home" : "🏠 ہوم" } }] },
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

async function sendHomeChip(to, lang = "ur") {
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
          action: { buttons: [{ type: "reply", reply: { id: "home", title: lang === "en" ? "🏠 Home" : "🏠 ہوم" } }] },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { /* non-critical */ }
}


// Aesthetic services list — shown when the patient picks Aesthetic.
// (Edit rows here to match the knowledge sheet; ids stay aes_*.)
const AES_ROWS_UR = [
  { id: "aes_hydrafacial", title: "💧 ہائیڈرا فیشل" },
  { id: "aes_carbonlaser", title: "✨ کاربن لیزر" },
  { id: "aes_prp", title: "💉 پی آر پی (جلد و بال)" },
  { id: "aes_bbglow", title: "🌟 بی بی گلو" },
  { id: "aes_peel", title: "🍋 کیمیکل پیل" },
  { id: "aes_whitening", title: "🤍 وائٹننگ ٹریٹمنٹ" },
  { id: "aes_laserhair", title: "🔦 لیزر ہیئر ریموول" },
  { id: "aes_other", title: "📋 دیگر / مشورہ" },
];
const AES_ROWS_EN_SRC = [
  { id: "aes_hydrafacial", title: "💧 HydraFacial" },
  { id: "aes_carbonlaser", title: "✨ Carbon Laser" },
  { id: "aes_prp", title: "💉 PRP Skin & Hair" },
  { id: "aes_bbglow", title: "🌟 BB Glow" },
  { id: "aes_peel", title: "🍋 Chemical Peel" },
  { id: "aes_whitening", title: "🤍 Whitening Treatment" },
  { id: "aes_laserhair", title: "🔦 Laser Hair Removal" },
  { id: "aes_other", title: "📋 Other / Consultation" },
];
const AES_ROWS_EN = AES_ROWS_EN_SRC;

export async function sendAestheticMenu(to, lang = "ur") {
  const body = lang === "en"
    ? "*Aesthetica by DFH* ✨\nFREE skin consultation with *Dr. Semi Gul* (FCPS Dermatology).\nSelect the treatment you are interested in:"
    : "*ایستھیٹیکا بائے ڈی ایف ایچ* ✨\n*ڈاکٹر سیمی گل* (ماہرِ امراضِ جلد) کے ساتھ جلد کا *مفت* مشورہ۔\nجس علاج میں دلچسپی ہے، منتخب کریں:";
  try {
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
            button: lang === "en" ? "Select treatment" : "منتخب کریں",
            sections: [{ title: lang === "en" ? "Aesthetic Services" : "ایستھیٹک سروسز", rows: lang === "en" ? AES_ROWS_EN : AES_ROWS_UR }],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("aesthetic menu failed:", e.response?.data?.error?.message || e.message);
    await sendText(to, body);
  }
}
