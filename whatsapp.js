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

// Rotating welcome texts — never the same greeting twice (variant = menuCount).
const WELCOME_UR = [
  "السلام علیکم! 🌸\nمیں زینب ہوں — *ڈاؤن ٹاؤن فیملی ہسپتال* میں دل سے خوش آمدید!\n\n✔ ہم ایک *آئی ایچ آر اے رجسٹرڈ ہسپتال* ہیں\n✔ پتہ: بیل روڈ، جی ٹین مرکز، اسلام آباد\n✔ اپنی تمام صحت کی خدمات کی ہم مکمل ذمہ داری لیتے ہیں\n✔ ویب سائٹ: www.dfh.com.pk\n\nآپ مجھ سے کوئی بھی سوال پوچھ سکتے ہیں 🙂 یا نیچے سے اپنی سروس منتخب کریں:",
  "جی آیاں نوں! 🌸 میں زینب حاضر ہوں۔\nکوئی سوال ہو تو بلا جھجک پوچھیں، یا نیچے دی گئی سروسز میں سے انتخاب فرمائیں:",
  "خوش آمدید! 🙂 بتائیں آج کس چیز میں مدد کروں؟\nنیچے ہماری سروسز کی فہرست موجود ہے — اپنی ضرورت کی سروس چن لیں:",
  "السلام علیکم! 🌸 بتائیں، آج کیا مدد چاہیے؟\nہماری سروسز نیچے موجود ہیں — منتخب کر لیں، یا کوئی بھی سوال لکھ دیں:",
];
const WELCOME_EN = [
  "Welcome! 🌸 I'm Zainab from *Downtown Family Hospital*.\n\n✔ We are an *IHRA Registered Hospital*\n✔ Located at Belle Road, G-10 Markaz, Islamabad\n✔ We take full responsibility for all our health services\n✔ More info: www.dfh.com.pk\n\nAsk me anything 🙂 or select a service below:",
  "Good to see you again! 🌸 How can I help today?\nFeel free to ask any question, or pick a service from the list below:",
  "Welcome back! 🙂 What can I do for you today?\nOur services are listed below — choose the one you need:",
  "Hello again! 🌸 Zainab at your service.\nAsk me anything, or select from our services below:",
];

// Welcome menu: rotating intro + 6-service list (per spec).
export async function sendWelcomeMenu(to, lang = "ur", variant = 1) {
  const texts = lang === "en" ? WELCOME_EN : WELCOME_UR;
  const body = variant <= 1 ? texts[0] : texts[1 + ((variant - 2) % (texts.length - 1))];
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
