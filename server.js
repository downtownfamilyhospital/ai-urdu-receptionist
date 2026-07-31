// =========================================================
//  server.js  — THE MAIN PROGRAM (Phase 1)
//  This is the "brain stem" that connects everything:
//  WhatsApp in  →  AI thinks  →  WhatsApp out  +  save lead
// =========================================================

import "dotenv/config";
import express from "express";

// ---- NETWORK FIX for ERR_STREAM_PREMATURE_CLOSE ----
// Some Node builds drop gzip-compressed HTTPS responses mid-stream on
// certain networks (the "Gunzip premature close" error). We configure a
// global undici agent with keep-alive + generous timeouts and ask servers
// NOT to gzip, which avoids the broken decompression path.
try {
  const { setGlobalDispatcher, Agent } = await import("undici");
  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 60000,
      connect: { timeout: 30000 },
      headersTimeout: 60000,
      bodyTimeout: 60000,
    })
  );
  console.log("✅ Global network agent configured (keep-alive, timeouts)");
} catch (e) {
  console.log("network agent setup skipped:", e.message);
}


import { loadKnowledge } from "./knowledge.js";
import { askBrain } from "./brain.js";
import { sendText, sendTextWithHome, sendWelcomeMenu, sendLanguageSelect, sendAestheticMenu } from "./whatsapp.js";
import { chatApp } from "./chatweb.js";
import { transcribeVoice } from "./voice.js";
// Personal details (name/address) are never stored — but every contact's
// WhatsApp NUMBER is registered to the Patients sheet for campaigns.
import { registerContact } from "./patients.js";
import { saveCorrection, loadCorrections } from "./corrections.js";
import { forwardLeadToManager } from "./managers.js";
import { loadConversation, saveConversation, clearConversation, cleanupExpired } from "./conversations.js";
// Appointment reminders are DISABLED by owner request (2026-07-31):
// no reminder is scheduled or sent to patients or managers anywhere.
import { runCampaign, getApprovedTemplates } from "./campaign.js";
import { getAllPatients } from "./patients.js";
import {
  saveLead,
  saveMessage,
  getRecentHistory,
  getStats,
  getConversations,
  getConversation,
  getPatientLead,
  wasRecentlyForwarded,
  saveForwardedLead,
  getForwardedLeads,
  getActiveDept,
  setActiveDept,
  minutesSinceLastActivity,
  touchActivity,
  getLang,
  setLang,
  bumpMenuCount,
  getCollected,
  mergeCollected,
  clearCollected,
  getLastWeeklyReport,
  setLastWeeklyReport,
  getPendingAd,
  setPendingAd,
} from "./database.js";

// ===== Meta-ad generic openers =====
// Click-to-WhatsApp ads pre-fill messages like "How can I get more info?".
// These carry ZERO real intent — treat them exactly like a greeting:
// warm welcome + language buttons, then the services menu.
// A SPECIFIC question (mentions a service/doctor/price of something) is NOT
// intercepted — the brain answers it directly.
function isGenericAdOpener(raw) {
  const t = (raw || "")
    .toLowerCase()
    .replace(/[!.,؟?،۔'’"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const exact = [
    "how can i get more info", "can i get more info", "i want more info",
    "more info", "more information", "info", "information", "details", "detail",
    "i'd like to know more", "i would like to know more", "tell me more",
    "know more", "learn more", "get started", "interested", "i am interested",
    "i'm interested", "im interested", "need info", "need information",
    "share details", "kindly share details", "send details", "price", "prices",
    "rates", "charges", "fees", "which doctor", "which dr", "kaunsa doctor",
    "konsa doctor", "kon sa doctor", "doctor available", "mazeed malumat",
    "malumat", "maloomat", "malumat chahiye", "maloomat chahiye", "tafseel",
    "tafseelat", "مزید معلومات", "معلومات", "معلومات چاہیے", "تفصیل",
    "تفصیلات", "کون سا ڈاکٹر", "کونسا ڈاکٹر", "قیمت", "فیس", "ریٹ",
  ];
  if (exact.includes(t)) return true;
  // Short message with a generic-intent keyword but NO specific service/doctor
  // named → still a generic opener.
  if (t.split(" ").length <= 7) {
    const genericKey = /(more info|more information|get info|know more|tell me more|learn more|interested|details?|information|maloomat|malumat|tafseel|which doctor|which dr|kaunsa doctor|konsa doctor|kon sa doctor|مزید معلومات|معلومات|تفصیل|دلچسپی)/;
    const specific = /(prp|hydra|facial|laser|peel|glow|whitening|physio|pharm|medicin|dawai|dava|lab|test|nursing|nurse|ultrasound|x-?ray|gyn|dental|derma|skin|hair|sugar|bp|fever|price of|fee of|rate of|dr\s+[a-z\u0600-\u06FF])/;
    if (genericKey.test(t) && !specific.test(t)) return true;
  }
  return false;
}
import { runWeeklyAnalysis, sendWeeklyReport } from "./weekly-analysis.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================================================
//  SERVICE OPERATING HOURS (Pakistan Standard Time) — HARD GATE
//  Enforced in CODE, before any AI call, info collection or
//  lead: outside hours the patient gets ONLY the closure
//  message. Pharmacy is 24/7 (never gated). appointment /
//  aesthetic are hospital-visit referrals — not gated here.
// =========================================================
// Times in MINUTES since midnight (PKT) for half-hour precision.
const SERVICE_HOURS = {
  online: { open: 9 * 60, close: 23 * 60 + 30 }, // 9:00 AM – 11:30 PM
  nursing: { open: 9 * 60, close: 22 * 60 },     // 9:00 AM – 10:00 PM
  physio: { open: 9 * 60, close: 22 * 60 },      // 9:00 AM – 10:00 PM
  lab: { open: 9 * 60, close: 22 * 60 },         // 9:00 AM – 10:00 PM
};

function pkMinutesNow() {
  const parts = new Date()
    .toLocaleString("en-US", { timeZone: "Asia/Karachi", hour12: false, hour: "2-digit", minute: "2-digit" })
    .split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function pkHourNow() {
  // kept for logs: "13:05"-style PKT time
  const m = pkMinutesNow();
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

// Returns the closure message if `dept` is currently CLOSED, else null.
function serviceClosedMessage(dept, lang = "ur") {
  const rule = SERVICE_HOURS[(dept || "").toLowerCase()];
  if (!rule) return null; // pharmacy / appointment / aesthetic / general — never gated
  const m = pkMinutesNow();
  if (m >= rule.open && m < rule.close) return null; // open now

  const MSGS = {
    online: {
      en:
        "Thank you for contacting Downtown Family Hospital.\n" +
        "Our Online Doctor Consultation service is currently closed.\n" +
        "Service hours are daily from *9:00 AM to 11:30 PM* (Pakistan Standard Time).\n" +
        "Please contact us again after 9:00 AM and our doctors will be happy to assist you.\n" +
        "If your condition is urgent or severe, please visit your nearest emergency department or hospital immediately.\n" +
        "Thank you.",
      ur:
        "ڈاؤن ٹاؤن فیملی ہسپتال سے رابطے کا شکریہ 🌸\n" +
        "ہماری آن لائن ڈاکٹر مشورہ سروس اس وقت بند ہے۔\n" +
        "سروس کے اوقات روزانہ *صبح 9 بجے سے رات ساڑھے 11 بجے تک* (پاکستانی وقت) ہیں۔\n" +
        "براہِ کرم صبح 9 بجے کے بعد دوبارہ رابطہ کریں — ہمارے ڈاکٹرز آپ کی مدد کے لیے حاضر ہوں گے۔\n" +
        "اگر آپ کی حالت سنگین یا ہنگامی ہے تو براہِ کرم فوراً قریب ترین ایمرجنسی یا ہسپتال تشریف لے جائیں۔\n" +
        "شکریہ۔",
    },
    physio: {
      en:
        "Our Home Physiotherapy service is currently unavailable.\n" +
        "Service hours are daily from *9:00 AM to 10:00 PM*.\n" +
        "Please contact us again during service hours.\n" +
        "If immediate medical attention is required, please visit the nearest healthcare facility.\n" +
        "Thank you.",
      ur:
        "ہماری ہوم فزیوتھراپی سروس اس وقت دستیاب نہیں ہے۔\n" +
        "سروس کے اوقات روزانہ *صبح 9 بجے سے رات 10 بجے تک* ہیں۔\n" +
        "براہِ کرم انہی اوقات میں دوبارہ رابطہ کریں۔\n" +
        "اگر فوری طبی مدد درکار ہو تو براہِ کرم قریب ترین طبی مرکز تشریف لے جائیں۔\n" +
        "شکریہ۔",
    },
    nursing: {
      en:
        "Our Home Nursing service is currently unavailable.\n" +
        "Service hours are daily from *9:00 AM to 10:00 PM*.\n" +
        "Please contact us again during service hours.\n" +
        "If immediate medical attention is required, please visit the nearest healthcare facility.\n" +
        "Thank you.",
      ur:
        "ہماری ہوم نرسنگ سروس اس وقت دستیاب نہیں ہے۔\n" +
        "سروس کے اوقات روزانہ *صبح 9 بجے سے رات 10 بجے تک* ہیں۔\n" +
        "براہِ کرم انہی اوقات میں دوبارہ رابطہ کریں۔\n" +
        "اگر فوری طبی مدد درکار ہو تو براہِ کرم قریب ترین طبی مرکز تشریف لے جائیں۔\n" +
        "شکریہ۔",
    },
    lab: {
      en:
        "Our Home Lab Sample Collection service is currently unavailable.\n" +
        "Service hours are daily from *9:00 AM to 10:00 PM*.\n" +
        "Please contact us again during service hours.\n" +
        "Thank you.",
      ur:
        "ہماری ہوم لیب سیمپل کلیکشن سروس اس وقت دستیاب نہیں ہے۔\n" +
        "سروس کے اوقات روزانہ *صبح 9 بجے سے رات 10 بجے تک* ہیں۔\n" +
        "براہِ کرم انہی اوقات میں دوبارہ رابطہ کریں۔\n" +
        "شکریہ۔",
    },
  };
  const msgSet = MSGS[(dept || "").toLowerCase()];
  return msgSet ? (lang === "en" ? msgSet.en : msgSet.ur) : null;
}

// ---- Health check (so you can confirm the server is alive) ----
// ================= WEB CHAT (form-card interface) =================
const webHistory = new Map(); // session -> [{role,content}] (in-memory)

app.get("/chat", (req, res) => res.send(chatApp()));

app.post("/chat/api/message", async (req, res) => {
  try {
    const { session, text, form } = req.body || {};
    if (!session) return res.status(400).json({ error: "no session" });
    const hist = webHistory.get(session) || [];

    // Build the user turn: free text or a structured form submission.
    let userText = (text || "").trim();
    if (form && form.formId) {
      const pairs = Object.entries(form.data || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("، ");
      userText = `(مریض نے "${form.formId}" فارم جمع کیا — ${pairs})`;
    }
    if (!userText) return res.json({ reply: "", show_form: "" });

    const [kRes, cRes] = await Promise.allSettled([loadKnowledge(), loadCorrections()]);
    const knowledge = kRes.status === "fulfilled" ? kRes.value : "";
    const corrections = cRes.status === "fulfilled" ? cRes.value : "";
    const knowledgePlus = corrections ? `${knowledge}\n${corrections}` : knowledge;

    const brainInput =
      `(صرف آپ کی معلومات کے لیے — چینل: ویب چیٹ۔ معلومات لینے کے لیے META کے show_form استعمال کریں، text فارم نہ لکھیں۔ موجودہ پاکستان وقت: ${new Date().toLocaleString("en-US",{timeZone:"Asia/Karachi",weekday:"long",year:"numeric",month:"long",day:"numeric",hour:"numeric",minute:"2-digit",hour12:true})})\n\n` +
      userText;

    const { reply, meta } = await askBrain(brainInput, knowledgePlus, hist);

    // SERVICE-HOURS (web chat): information stays 24/7; while the service is
    // closed for booking, suppress the form and block the lead below.
    const webDept = (meta.department || "").toLowerCase();
    const webBookingClosed = !!serviceClosedMessage(webDept, "ur");
    if (webBookingClosed) {
      console.log(`⏰ Booking closed (web): ${webDept} — form suppressed, lead blocked`);
      meta.show_form = "";
      meta.lead_complete = false;
    }

    // maintain short history
    hist.push({ role: "user", content: userText });
    hist.push({ role: "assistant", content: reply });
    while (hist.length > 14) hist.shift();
    webHistory.set(session, hist);

    // Lead forwarding from web: same rules; pharmacy allowed here (explicit
    // delivery form), online/nursing/lab route to hospital manager.
    if (meta.lead_complete && meta.lead_summary) {
      const dept = (meta.department || "general").toLowerCase();
      const num = (meta.contact_number || "").replace(/[^0-9]/g, "");
      if (num.length >= 10) {
        const managerDept = (dept === "online" || dept === "nursing" || dept === "lab" || dept === "physio") ? "appointment" : dept;
        const key = "+92" + num.replace(/^0/, "").replace(/^92/, "");
        if (!wasRecentlyForwarded(key, dept, 6)) {
          const deliveredWeb = await forwardLeadToManager(managerDept, `${meta.lead_summary}\nPatient name: ${meta.patient_name}\n(Please check, confirm and call the patient on WhatsApp within 10 minutes)\n(Source: Website chat)`, key);
          if (deliveredWeb) await saveForwardedLead({ whatsapp_number: key, patient_name: meta.patient_name, department: dept, summary: meta.lead_summary });
          else console.error(`❌ WEB LEAD SEND FAILED (${dept}) — not marked as forwarded`);
        }
      }
    }
    res.json({ reply, show_form: meta.show_form || "" });
  } catch (e) {
    console.error("web chat error:", e.message);
    res.status(500).json({ reply: "معذرت، تھوڑی دیر بعد کوشش کریں 🌸", show_form: "" });
  }
});

app.get("/", (req, res) => {
  res.send("AI Urdu Hospital Receptionist is running ✅");
});

// Diagnostic: test outbound network to Google + OpenAI. Visit /diag
// in your browser to see if the container can reach the internet.
app.get("/diag", async (req, res) => {
  const out = {};
  const test = async (name, url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: "GET" });
      out[name] = `OK (${r.status}) in ${Date.now() - t0}ms`;
    } catch (e) {
      out[name] = `FAIL: ${e.message} (${Date.now() - t0}ms)`;
    }
  };
  await test("google", "https://www.googleapis.com/discovery/v1/apis");
  await test("openai", "https://api.openai.com/v1/models");
  await test("example", "https://example.com");
  res.json({ time: new Date().toISOString(), results: out });
});

// ---- WhatsApp webhook VERIFICATION (360dialog/Meta handshake) ----
app.get("/webhook", (req, res) => {
  const token = req.query["hub.verify_token"];
  if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ---- WhatsApp webhook: a patient sent us a message ----
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // tell WhatsApp "got it" immediately

  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    // DIAGNOSTIC: log the type of every incoming message so we can see voice notes
    const incomingType = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.type;
    if (incomingType) console.log(`📥 incoming message type: ${incomingType}`);
    const message = entry?.messages?.[0];
    if (!message) return; // could be a status update, ignore

    const from = message.from;               // patient's WhatsApp number (e.g. 923xxxxxxxxx)
    // Standardize to international format with + prefix, no dashes.
    const fromFormatted = from.startsWith("+") ? from : `+${from}`;
    const profileName = entry?.contacts?.[0]?.profile?.name || "";

    // --- AD REFERRAL: did this patient arrive by clicking a Meta ad? ---
    // Meta includes a "referral" object on the FIRST message after an ad click.
    let adContext = "";
    if (message.referral) {
      const r = message.referral;
      const headline = r.headline || "";
      const body = r.body || "";
      const source = r.source_type || r.source_id || "";
      adContext =
        `(The patient just arrived by clicking a Meta ad. ` +
        `Ad headline: "${headline}". Ad text: "${body}". ` +
        `Warmly acknowledge this specific ad/service, give relevant info, and convince them to visit.)`;
      console.log(`📣 Ad click! headline="${headline}" body="${body.slice(0, 60)}"`);
    }

    // Work out what the patient "said" as text.
    // - text message  → use it directly
    // - voice note     → transcribe with Whisper (Phase 2A)
    // - anything else  → politely ask for text or voice
    let patientText = "";
    let isVoiceNote = false;
    let isImageMessage = false;
    let wasVoice = false;

    if (message.type === "interactive") {
      const id = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || "";
      if (id === "lang_ur" || id === "lang_en") {
        await setLang(fromFormatted, id === "lang_en" ? "en" : "ur");
        const v = await bumpMenuCount(fromFormatted);
        await sendWelcomeMenu(from, getLang(fromFormatted), v);
        return;
      }
      if (id === "home") {
        await setActiveDept(fromFormatted, "");
        // Back to home → always let the patient pick the language again;
        // the welcome menu follows after they choose (lang_ur / lang_en).
        await sendLanguageSelect(from);
        return; // language choice shown; menu follows
      }
      const deptMap = { dept_appointment: "appointment", dept_online: "online", dept_pharmacy: "pharmacy", dept_nursing: "nursing", dept_lab: "lab", dept_aesthetic: "aesthetic", dept_physio: "physio" };
      if (id === "dept_aesthetic") {
        await setActiveDept(fromFormatted, "aesthetic");
        await sendAestheticMenu(from, getLang(fromFormatted) || "ur");
        return; // wait for the treatment choice
      }
      if (id.startsWith("aes_")) {
        await setActiveDept(fromFormatted, "aesthetic");
        const title = message.interactive?.list_reply?.title || "aesthetic service";
        const selLang0 = getLang(fromFormatted) || "ur";
        patientText = selLang0 === "en"
          ? `(Patient selected this aesthetic treatment from the list: ${title}) I am interested in this.`
          : `(مریض نے ایستھیٹک فہرست سے یہ treatment چنی ہے: ${title}) مجھے اس میں دلچسپی ہے۔`;
      } else if (deptMap[id]) {
        // NOTE: no hard block here — INFORMATION is 24/7. If the service is
        // closed for booking, the booking-closed note (below) makes the AI
        // answer questions but never collect info or create a lead.
        await setActiveDept(fromFormatted, deptMap[id]);
        // Let the brain open the chosen department naturally — in the
        // patient's chosen language (English injection keeps replies English).
        const selLang = getLang(fromFormatted) || "ur";
        patientText = selLang === "en"
          ? `(Patient selected this service from the menu: ${deptMap[id]}) I need help with this service.`
          : `(مریض نے مینو سے یہ سروس چنی ہے: ${deptMap[id]}) اس سروس کے بارے میں مدد چاہیے`;
      } else {
        patientText = message.interactive?.list_reply?.title || message.interactive?.button_reply?.title || "";
      }
    } else if (message.type === "text") {
      patientText = message.text.body;
      const lower0 = patientText.trim().toLowerCase();
      // Typed Home also resets
      if (["ہوم", "home", "🏠", "🏠 ہوم", "🏠 home", "menu", "مینو"].includes(lower0)) {
        await setActiveDept(fromFormatted, "");
        // Back to home → language choice first, then the menu.
        await sendLanguageSelect(from);
        return;
      }
      // Language switch by typing
      if (["english", "انگلش", "انگریزی"].includes(lower0)) { await setLang(fromFormatted, "en"); await sendTextWithHome(from, "Language set to English ✅ How can I help you?", "en"); return; }
      if (["urdu", "اردو"].includes(lower0)) { await setLang(fromFormatted, "ur"); await sendTextWithHome(from, "زبان اردو ہو گئی ✅ بتائیں کیا مدد کروں؟", "ur"); return; }
      // Greeting OR generic Meta-ad auto-message ("How can I get more info?",
      // "which doctor", "hi") → deterministic welcome flow:
      //   1st contact → warm welcome + language buttons
      //   language known + fresh chat → welcome menu with the services list
      // Specific questions are NOT intercepted — the brain answers directly.
      const greetings = ["hi","hello","hey","salam","aoa","assalamualaikum","assalam o alaikum","السلام علیکم","سلام","اسلام علیکم"];
      const isOpener = greetings.includes(lower0.replace(/[!.،۔]/g, "").trim()) || isGenericAdOpener(patientText);
      if (isOpener) {
        // Never lose WHICH ad they clicked — park it for after language choice.
        if (adContext) await setPendingAd(fromFormatted, adContext);
        if (!getLang(fromFormatted)) {
          await sendLanguageSelect(from); // very first contact: welcome + language choice
          return;
        }
        const hist0 = await loadConversation(fromFormatted);
        if (!hist0 || hist0.length === 0) {
          const v = await bumpMenuCount(fromFormatted);
          await sendWelcomeMenu(from, getLang(fromFormatted), v);
          return;
        }
        // Mid-conversation greeting → let the brain handle it with context.
      }
      // Content-ful first message: DON'T force language buttons — the brain
      // auto-detects the patient's language (English vs Urdu/Roman Urdu)
      // and reports it via META.lang; we persist it below.
    } else if (message.type === "image") {
      // Images flow into the AI so she can respond by CONTEXT:
      // medicine/prescription photo → refer to Pharmacy Manager;
      // online-consultation payment screenshot → accept + confirm;
      // otherwise → politely say she can't view images.
      console.log(`🖼️ ${from}: image received — handling by conversation context`);
      patientText = "(📷 مریض نے ایک تصویر بھیجی ہے)";
      isImageMessage = true;
    } else if (message.type === "audio") {
      wasVoice = true;
      console.log(`🎤 ${from}: voice note received, transcribing...`);
      try {
        const transcribed = await transcribeVoice(message.audio.id);
        console.log(`🎤 → transcribed: ${transcribed}`);
        // Tag it as voice so Zainab confirms she heard names/numbers right.
        // Keep the patient's words clean (this is what gets saved/shown).
        // Any guidance for Zainab is added separately, not into patientText.
        patientText = transcribed;
        isVoiceNote = true;
      } catch (e) {
        console.error("Transcription error:", e.response?.data || e.message);
        await sendText(
          from,
          "معذرت، میں آپ کا وائس میسج سمجھ نہیں سکی۔ براہِ کرم دوبارہ بھیجیں یا لکھ کر بتائیں۔"
        );
        return;
      }
      if (!patientText.trim()) {
        await sendText(
          from,
          "معذرت، آواز صاف نہیں آئی۔ براہِ کرم دوبارہ وائس میسج بھیجیں یا لکھ دیں۔"
        );
        return;
      }
    } else if (message.type === "location") {
      // Patient shared a GPS location pin — save it to their record.
      const lat = message.location?.latitude;
      const lng = message.location?.longitude;
      const pin = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : "";
      if (pin) {
        // Not stored permanently — flows into the current conversation only.
        console.log(`📍 ${from}: location pin received (not stored)`);
      }
      await sendText(
        from,
        "شکریہ! 🌸 آپ کی لوکیشن موصول ہو گئی ہے۔ ہماری ٹیم اسی پتے پر سروس بھیج دے گی۔"
      );
      return;
    } else {
      // images, documents, etc. — not handled yet
      await sendText(
        from,
        "السلام علیکم! آپ مجھے لکھ کر یا وائس میسج کے ذریعے سوال بھیج سکتے ہیں۔ شکریہ۔"
      );
      return;
    }

    console.log(`📩 ${from}: ${patientText}`);

    // ---- LIVE CORRECTION: "zainab zainab [SECRET] [correction]" ----
    // Lets trusted people (who know the secret) teach Zainab. The
    // correction is saved to the Sheet and applied to ALL clients.
    const lower = patientText.toLowerCase().trim();
    if (lower.startsWith("zainab zainab")) {
      const rest = patientText.trim().slice("zainab zainab".length).trim();
      const secret = process.env.CORRECTION_SECRET || "";
      // rest should start with the secret word, then the correction
      if (secret && rest.toLowerCase().startsWith(secret.toLowerCase())) {
        const correctionText = rest.slice(secret.length).trim();
        if (correctionText) {
          // Try to find a date in the correction → use as auto-expiry.
          // Supports: 2026-06-25, 25/6/2026, 25-06-2026, "25 June 2026".
          let expires = "";
          const iso = correctionText.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
          const dmy = correctionText.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
          const named = correctionText.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
          const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
          const pad = (n) => String(n).padStart(2, "0");
          if (iso) {
            expires = `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
          } else if (dmy) {
            expires = `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
          } else if (named) {
            expires = `${named[3]}-${pad(months[named[2].toLowerCase()])}-${pad(named[1])}`;
          }
          const ok = await saveCorrection(correctionText, from, expires);
          await sendText(
            from,
            ok
              ? `شکریہ! ✅ اصلاح محفوظ کر لی گئی ہے۔${expires ? ` (یہ ${expires} کے بعد خود بخود ختم ہو جائے گی)` : ""}\n("${correctionText}")`
              : "معذرت، اصلاح محفوظ نہیں ہو سکی۔ دوبارہ کوشش کریں۔"
          );
        } else {
          await sendText(from, "اصلاح خالی ہے۔ مثال: zainab zainab [secret] PRP ki fee 15000 hai");
        }
      } else {
        // wrong/missing secret. Don't reveal the secret exists to outsiders,
        // but the owner needs a hint. Give a neutral message.
        await sendText(from, "معذرت، یہ کمانڈ مکمل یا درست نہیں۔ (correction کے لیے درست secret لازمی ہے۔)");
      }
      return; // don't run the normal AI flow for a correction command
    }

    // ===== 5-minute inactivity reset (rules 6-7): fresh session =====
    // MUST run before history is loaded/used (declared before any use).
    let sessionReset = false;
    const idleMin = minutesSinceLastActivity(fromFormatted);
    // 30-min threshold (bank transfers/payments routinely take >5 min), and
    // an incoming IMAGE never triggers a reset — it is usually the payment
    // screenshot returning after a transfer delay. Resetting here caused
    // the "re-asks everything after screenshot" bug.
    if (idleMin !== null && idleMin > 30 && !isImageMessage) {
      await setActiveDept(fromFormatted, "");
      try { await clearConversation(fromFormatted); } catch (e) {}
      await clearCollected(fromFormatted); // fresh session — no old personal data
      sessionReset = true;
      console.log(`⏳ ${fromFormatted}: idle ${Math.round(idleMin)} min — session reset to fresh`);
    }
    await touchActivity(fromFormatted);
    registerContact(fromFormatted).catch(() => {}); // campaign registry (non-blocking)

    // 1+2. Load knowledge, corrections, and conversation IN PARALLEL.
    //      Use allSettled so a transient Google hiccup on one read doesn't
    //      break the whole reply — we degrade gracefully instead.
    const [kRes, cRes, hRes] = await Promise.allSettled([
      loadKnowledge(),
      loadCorrections(),
      loadConversation(fromFormatted),
    ]);
    const knowledge = kRes.status === "fulfilled" ? kRes.value : "";
    const corrections = cRes.status === "fulfilled" ? cRes.value : "";
    const loadedHistory = hRes.status === "fulfilled" ? hRes.value : [];
    if (kRes.status === "rejected") console.error("knowledge load failed:", kRes.reason?.message);
    const knowledgePlus = corrections ? `${knowledge}\n${corrections}` : knowledge;

    let history = loadedHistory;
    if (sessionReset) history = []; // fresh session — forget earlier conversation state
    if (!history || history.length === 0) history = getRecentHistory(from);

    // No permanent patient memory — every booking collects fresh info.

    // 3. Ask the AI brain (include patient memory + ad context + current time)
    const fmtDate = (d) =>
      d.toLocaleString("en-US", {
        timeZone: "Asia/Karachi", weekday: "long", year: "numeric",
        month: "long", day: "numeric",
      });
    const nowPk = new Date();
    const pktTime = nowPk.toLocaleString("en-US", {
      timeZone: "Asia/Karachi", weekday: "long", year: "numeric",
      month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    });
    // Pre-compute relative dates so "tomorrow"/"day after" become exact dates.
    const tomorrow = new Date(nowPk.getTime() + 24 * 60 * 60 * 1000);
    const dayAfter = new Date(nowPk.getTime() + 48 * 60 * 60 * 1000);
    const isoDay = (d) =>
      d.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }); // YYYY-MM-DD
    const dateHelp =
      `آج: ${pktTime}۔ ` +
      `"کل/tomorrow" کا مطلب ${fmtDate(tomorrow)} (${isoDay(tomorrow)})۔ ` +
      `"پرسوں/day after" کا مطلب ${fmtDate(dayAfter)} (${isoDay(dayAfter)})۔ ` +
      `جب مریض "کل"، "پرسوں"، "اگلے ہفتے" وغیرہ کہے تو خلاصے اور visit_at میں ہمیشہ اصل مکمل تاریخ لکھیں (جیسے 5 July 2026)، صرف "کل" نہ لکھیں۔`;
    const activeDept = getActiveDept(fromFormatted);
    const storedLang = getLang(fromFormatted);
    const lang = storedLang || "ur";

    // SERVICE-HOURS SEPARATION: information is 24/7; only BOOKING is gated.
    // If the active service is closed for booking, inject a note so the AI
    // answers every question fully but never collects info or completes a
    // lead — and politely gives the hours if the patient wants to book.
    // (Exception: online payment screenshots are never gated.)
    const activeClosedMsg = serviceClosedMessage(activeDept, lang);
    const bookingClosed = !!activeClosedMsg && !(activeDept === "online" && isImageMessage);
    const bookingClosedNote = bookingClosed
      ? `اہم — بُکنگ اس وقت بند ہے (معلومات چوبیس گھنٹے کھلی ہیں): مریض کے تمام معلوماتی سوالوں (فیس، ڈاکٹر، اوقات، سہولیات وغیرہ) کے مکمل جواب دیں، مگر کوئی ذاتی معلومات جمع نہ کریں (نہ نام، نہ نمبر، نہ پتہ، نہ علامات) اور lead_complete کبھی true نہ کریں۔ مریض بُکنگ کرنا چاہے تو نرمی سے بتائیں: یہ سروس روزانہ [آن لائن: صبح 9 تا رات ساڑھے 11 | نرسنگ/فزیو/لیب: صبح 9 تا رات 10] بُکنگ لیتی ہے — انہی اوقات میں رابطہ کریں تو میں فوراً بُک کر دوں گی۔ `
      : "";
    if (bookingClosed) console.log(`⏰ Booking closed for ${activeDept} (PKT ${pkHourNow()}) — info-only mode`);
    const langNote = !storedLang
      ? "LANGUAGE NOT SET YET — Detect from the patient's message: English message → reply in simple professional English and set META lang:\"en\". Urdu or Roman Urdu message → reply in pure Urdu and set META lang:\"ur\". "
      : lang === "en"
      ? "LANGUAGE: ENGLISH ONLY — The patient chose English. EVERY word of your reply, every question, every template, every form field, every confirmation and farewell must be in simple professional English until the conversation ends. Translate any Urdu script/template into natural English. Never write Urdu. "
      : "زبان: صرف اردو — مریض نے اردو چنی ہے۔ آخر تک ہر جواب، سوال، فارم اور پیغام خالص اردو میں۔ ";
    const deptNote = langNote + (activeDept
      ? `فعال شعبہ: ${activeDept} — صرف اسی شعبے کے اصول استعمال کریں، دوسرے شعبے نہ ملائیں۔ `
      : "");
    // FIX (never re-ask): inject whatever was already captured in this
    // workflow, so the bot can never ask for the name/number/etc. twice —
    // even if the original answer rolled out of the history window.
    const collected = getCollected(fromFormatted);
    let collectedNote = "";
    if (collected) {
      const parts = [];
      if (collected.patient_name) parts.push(`نام: ${collected.patient_name}`);
      if (collected.contact_number) parts.push(`نمبر: ${collected.contact_number}`);
      if (collected.address) parts.push(`پتہ: ${collected.address}`);
      if (collected.medical_issue) parts.push(`طبی مسئلہ: ${collected.medical_issue}`);
      if (collected.visit_at) parts.push(`طے شدہ وقت: ${collected.visit_at}`);
      if (parts.length) {
        collectedNote = `پہلے سے موصول معلومات (دوبارہ کبھی نہ پوچھیں، خاموشی سے استعمال کریں): ${parts.join("، ")}۔ `;
      }
    }
    let brainInput = `(صرف آپ کی معلومات کے لیے — ${deptNote}${bookingClosedNote}${collectedNote}${dateHelp} اسے جواب میں مت لکھیں جب تک پوچھا نہ جائے۔)\n\n${patientText}`;
    if (isVoiceNote) {
      brainInput =
        `(نوٹ: یہ مریض کا وائس میسج تھا جو ٹیکسٹ میں بدلا گیا۔ اگر اس میں مریض نے اپنا نام/نمبر/پتہ بتایا ہو تو نرمی سے تصدیق کر لیں کہ آپ نے ٹھیک سنا۔ اگر ایسی کوئی معلومات نہیں تھی تو تصدیق کا ذکر بالکل نہ کریں۔)\n\n` +
        brainInput;
    }
    if (isImageMessage) {
      // GOLDEN RULE (dept isolation): payment-screenshot recognition exists
      // ONLY inside the Online Video Consultation department, and only after
      // payment was requested. Every other department treats an image as a
      // normal image — never mentions payment — and refers the patient to
      // that department's own WhatsApp number.
      const DEPT_IMG_NUM = {
        pharmacy: "+923700352287",
        lab: "+923330352287",
        nursing: "+923330352287",
        physio: "+923330352287",
        aesthetic: "+923455216903",
      };
      let imgNote;
      if (activeDept === "online") {
        imgNote =
          `(نوٹ: مریض نے تصویر بھیجی ہے۔ فعال شعبہ: آن لائن ویڈیو مشورہ۔ اگر آپ ادائیگی اور اسکرین شاٹ کی درخواست پہلے کر چکی ہیں تو اسے ادائیگی کا اسکرین شاٹ سمجھیں: صرف یہ کہیں کہ اسکرین شاٹ موصول ہو گیا ہے اور ٹیم تصدیق کر رہی ہے (کبھی نہ کہیں ادائیگی موصول/کنفرم ہو گئی)، تصدیق ہوتے ہی ڈاکٹر مقرر ہوگا، lead فوراً مکمل کریں، اس کے بعد کوئی سوال نہیں۔ اگر ابھی ادائیگی کی درخواست نہیں ہوئی تھی تو یہ عام تصویر ہے — نرمی سے کہیں کہ آپ تصویر نہیں پڑھ سکتیں، تفصیل لکھ کر بھیجیں۔)`;
      } else if (activeDept && DEPT_IMG_NUM[activeDept]) {
        imgNote =
          `(نوٹ: مریض نے تصویر بھیجی ہے۔ فعال شعبہ: ${activeDept} — یہ ادائیگی کا اسکرین شاٹ ہرگز نہیں، ادائیگی کا ذکر بالکل نہ کریں۔ نرمی سے کہیں: "میں اس چیٹ میں تصاویر یا ہاتھ سے لکھی دستاویزات درست طور پر نہیں پڑھ سکتی۔ مہربانی کر کے یا تو تصویر میں لکھی معلومات ٹائپ کر دیں، یا یہ تصویر براہِ راست متعلقہ شعبے کے واٹس ایپ نمبر پر بھیج دیں — ہماری ٹیم دیکھ کر مدد کرے گی۔" اور اسی پیغام میں یہ نمبر دیں: ${DEPT_IMG_NUM[activeDept]}۔)`;
      } else {
        imgNote =
          `(نوٹ: مریض نے تصویر بھیجی ہے، کوئی شعبہ فعال نہیں۔ ادائیگی کا ذکر بالکل نہ کریں۔ نرمی سے کہیں کہ آپ تصاویر نہیں پڑھ سکتیں — معلومات لکھ کر بھیجیں یا بتائیں کس سروس سے متعلق ہے تاکہ درست رہنمائی ہو۔)`;
      }
      brainInput = imgNote + `\n\n` + brainInput;
    }
    // If the ad click was intercepted by the language-select step, the ad
    // details were parked — retrieve them now so Zainab still acknowledges
    // the specific ad/service the patient came from.
    if (!adContext) {
      const parkedAd = getPendingAd(fromFormatted);
      if (parkedAd) {
        adContext = parkedAd;
        await setPendingAd(fromFormatted, ""); // use once, then clear
        console.log(`📣 Injecting parked ad context for ${from}`);
      }
    }
    if (adContext) brainInput = `${adContext}\n\n${brainInput}`;

    const { reply, meta } = await askBrain(brainInput, knowledgePlus, history);
    // Always-visible lead diagnostics (watch these in Railway logs):
    console.log(`🧠 META: dept=${meta.department || "-"} | lead_complete=${meta.lead_complete} | name=${meta.patient_name || "-"} | issue=${(meta.medical_issue || "-").slice(0, 40)} | lang=${meta.lang || "-"}`);

    // If this is a sales/marketing pitch, stay silent (no reply, no saves).
    if (meta.stay_silent) {
      console.log(`🤐 ${from}: sales/marketing pitch — staying silent`);
      return;
    }

    // (Information stays 24/7 — no reply override here. Booking is enforced
    // deterministically at the lead stage below.)

    // 4. SEND THE REPLY FIRST so the patient gets a fast response,
    //    THEN do the saves (patient isn't kept waiting on Sheet writes).
    // HARD SAFETY: never let the "my Urdu is weak" apology slip through,
    // no matter what the model or any old correction says.
    let safeReply = reply
      // Uniform numbers only — never send wa.me links; convert to plain number.
      .replace(/https?:\/\/wa\.me\/(\d+)/g, "+$1")
      .replace(/میری اردو[^۔\n]*(کم|کمزور|اچھی)[^۔\n]*۔?/g, "")
      .replace(/اردو[^۔\n]*معذرت[^۔\n]*۔?/g, "")
      .replace(/اردو[^۔\n]*معزرت[^۔\n]*۔?/g, "")
      .trim();
    if (!safeReply) safeReply = "جی، بتائیں میں آپ کی کیا مدد کر سکتی ہوں؟ 🌸";
    await sendTextWithHome(from, safeReply, lang);
    console.log(`🤖 → ${from}: ${safeReply.slice(0, 60)}...`);
    // Persist the language the brain detected/used (auto-detection + explicit switches).
    if (meta.lang === "en" || meta.lang === "ur") {
      if (meta.lang !== storedLang) await setLang(fromFormatted, meta.lang);
    }
    // Keep the department state machine in sync with the brain's detection.
    if ((meta.department || "") !== activeDept) {
      await setActiveDept(fromFormatted, meta.department || "");
    }
    // Remember every field the brain extracted this turn (never re-ask fix).
    await mergeCollected(fromFormatted, meta);
    // Rules 3-5: brain requested the menu (service selection / return home).
    if (meta.show_menu) {
      await setActiveDept(fromFormatted, "");
      const v = await bumpMenuCount(fromFormatted);
      await sendWelcomeMenu(from, lang, v); // second message: home menu
    }

    // 5. Save everything (after the reply is already on its way).
    saveMessage(from, "user", patientText);
    saveMessage(from, "assistant", safeReply);
    saveLead({
      patient_name: meta.patient_name,
      whatsapp_number: fromFormatted,
      inquiry: patientText,
      department: meta.department,
      intent: meta.intent,
      needs_human: meta.needs_human,
    });
    // Durable saves in parallel (conversation + patient memory).
    await saveConversation(fromFormatted, history, patientText, safeReply);

    // 6. If the AI says the lead is COMPLETE, prepare the manager summary.
    //    (For now we LOG it so we can test collection. Manager delivery
    //     via WhatsApp template is the next step once this works.)
    // Only forward if the lead is genuinely complete: must have a name
    // AND a contact number captured. This stops half-finished leads even
    // if the AI marks complete too early.
    // Online-consultation screenshot leads forward even without a name —
    // payment is the critical event; team completes details by call.
    const isOnlinePaid = (meta.department || "").toLowerCase() === "online";
    // Name gate: also accept the name from the captured-fields store, so a
    // lead is never blocked just because META missed the name this turn.
    const colGate = getCollected(fromFormatted) || {};
    const hasName = ((meta.patient_name || colGate.patient_name || "").trim().length > 1) || isOnlinePaid;
    const hasNumber = (meta.contact_number || fromFormatted || "").replace(/[^0-9]/g, "").length >= 11;
    // NEW WORKFLOW: pharmacy never creates leads — always a direct referral
    // to the Pharmacy Manager. Hard-block any pharmacy forward.
    if (meta.lead_complete && ["pharmacy", "appointment"].includes((meta.department || "").toLowerCase())) {
      console.log(`🚫 ${meta.department} lead blocked (referral-only workflow)`);
    } else if (
      // HARD BOOKING-HOURS BLOCK: no lead may EVER be created while the
      // service is closed (online payment screenshots excepted).
      meta.lead_complete &&
      serviceClosedMessage((meta.department || "").toLowerCase(), lang) &&
      !((meta.department || "").toLowerCase() === "online" && isImageMessage)
    ) {
      console.log(`⏰ Lead blocked — ${meta.department} is closed for booking (PKT ${pkHourNow()})`);
    } else if (meta.lead_complete && (!hasName || !hasNumber)) {
      console.log(`⏸️ Lead marked complete but missing ${!hasName ? "name" : "number"} — not forwarding yet`);
    } else if (meta.lead_complete) {
      const dept = meta.department || "general";
      console.log("==================================================");
      console.log(`✅ LEAD COMPLETE → department: ${dept}`);
      console.log(`👤 Patient: ${meta.patient_name} (${from})`);
      console.log(`📋 Summary for manager:\n${meta.lead_summary}`);
      console.log("==================================================");

      // Forward the lead to the relevant department manager's WhatsApp —
      // but NEVER forward a duplicate (same patient + same department
      // within 24h). Each template message costs money.
      // "online" is a separate department but its leads go to the SAME
      // hospital (appointment) manager number.
      // Per latest workflow: online, nursing AND lab leads all go to the Hospital Manager.
      const managerDept = (dept === "online" || dept === "nursing" || dept === "lab" || dept === "physio") ? "appointment" : dept;
      if (wasRecentlyForwarded(fromFormatted, dept, 6)) {
        console.log(`🔁 Duplicate lead skipped (${dept}, ${fromFormatted}) — already forwarded within 24h`);
      } else {
        // Meta-approved uniform number: patient-provided number normalized to
        // 923xxxxxxxxx (campaign-ready), falling back to the chat number.
        const givenDigits = (meta.contact_number || "").replace(/[^0-9]/g, "");
        const normGiven = givenDigits
          ? (givenDigits.startsWith("0") ? "92" + givenDigits.slice(1)
             : (givenDigits.startsWith("3") && givenDigits.length === 10) ? "92" + givenDigits
             : givenDigits)
          : "";
        const chatDigits = fromFormatted.replace(/[^0-9]/g, "");
        const contactFinal = normGiven || chatDigits;
        // Fill any gaps from the captured-fields store (survives history rollover).
        const col = getCollected(fromFormatted) || {};
        const nameFinal = ((meta.patient_name || col.patient_name || "").trim()) || "-";
        const issueFinal = ((meta.medical_issue || col.medical_issue || "").trim()) || "-";
        let fullSummary;
        if (dept === "online") {
          // Internal triage (never shown to the patient) — from the brain's summary.
          const suggested = (meta.lead_summary || "").match(/Suggested:\s*(Family Physician|Medical Specialist)/i);
          // Required format for online doctor consultation leads:
          fullSummary =
            `🩺 ONLINE DR CONSULTATION LEAD\n` +
            `Name: ${nameFinal}\n` +
            `WhatsApp No: +${contactFinal}\n` +
            `Medical Issue: ${issueFinal}\n` +
            `Screenshot uploaded: Yes\n` +
            (suggested ? `${suggested[0]}\n` : "") +
            `(Please check, confirm and call the patient on WhatsApp within 10 minutes)`;
        } else {
          // If the brain forgot the summary, synthesize one — never lose a lead.
          const summaryBase =
            (meta.lead_summary || "").trim() ||
            `${dept.toUpperCase()} LEAD — Issue: ${issueFinal}${col.address ? `, Address: ${col.address}` : ""}`;
          fullSummary = `${summaryBase}\nPatient name: ${nameFinal}\nWhatsApp: +${contactFinal}\n(Please check, confirm and call the patient on WhatsApp within 10 minutes)`;
        }
        const delivered = await forwardLeadToManager(managerDept, fullSummary, fromFormatted);
        if (delivered) {
          await saveForwardedLead({
            whatsapp_number: fromFormatted,
            patient_name: meta.patient_name,
            department: dept,
            summary: meta.lead_summary,
          });
        } else {
          // DO NOT record it as forwarded — otherwise the duplicate-check
          // would silently block every retry for hours after one failure.
          console.error(`❌ LEAD SEND FAILED (${dept}) — not marked as forwarded; will retry on the next trigger`);
        }
      }
      // (Appointment reminders disabled — nothing is scheduled here.)
      // Rule 9 (state management): lead done → LOCK the workflow but KEEP
      // the conversation memory. Wiping history here caused the restart bug
      // (bot re-asked name/age after the payment screenshot). The patient's
      // next message still has full context; questionnaire never reopens.
      await setActiveDept(fromFormatted, "");
      // Lead delivered → personal data no longer needed (privacy rule).
      await clearCollected(fromFormatted);
    }

    // ===== BULLETPROOF ONLINE LEAD (server-side guarantee) =====
    // If the patient sends an IMAGE in the online-consultation department
    // AFTER payment was requested (the bank account number appears in an
    // earlier bot message), that image IS the payment screenshot. Forward
    // the lead even if the AI forgot to set lead_complete — the online
    // lead must NEVER depend on the model alone.
    if (!meta.lead_complete && isImageMessage && activeDept === "online") {
      const paymentRequested = (history || []).some(
        (h) => h && h.role === "assistant" && (h.content || "").includes("305115802640001")
      );
      if (paymentRequested && !wasRecentlyForwarded(fromFormatted, "online", 6)) {
        const colB = getCollected(fromFormatted) || {};
        const digitsB = fromFormatted.replace(/[^0-9]/g, "");
        const forcedSummary =
          `🩺 ONLINE DR CONSULTATION LEAD\n` +
          `Name: ${colB.patient_name || meta.patient_name || "-"}\n` +
          `WhatsApp No: +${digitsB}\n` +
          `Medical Issue: ${colB.medical_issue || meta.medical_issue || "-"}\n` +
          `Screenshot uploaded: Yes\n` +
          `(Please check, confirm and call the patient on WhatsApp within 10 minutes)`;
        console.log("🛡️ Forced online lead — screenshot detected, AI missed lead_complete");
        const okForced = await forwardLeadToManager("appointment", forcedSummary, fromFormatted);
        if (okForced) {
          await saveForwardedLead({
            whatsapp_number: fromFormatted,
            patient_name: colB.patient_name || meta.patient_name || "",
            department: "online",
            summary: "ONLINE — payment screenshot received (forced server-side)",
          });
          await setActiveDept(fromFormatted, "");
          await clearCollected(fromFormatted);
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// =========================================================
//  ADMIN PORTAL  — login-protected
//  Routes: /portal (login + dashboard), /portal/chat/:number,
//          /portal/reply, /portal/login, /portal/logout
//  Login uses ADMIN_USER + ADMIN_PASS from Railway variables.
// =========================================================

const PORTAL_COOKIE = "dfh_portal";
function isLoggedIn(req) {
  const cookie = req.headers.cookie || "";
  return cookie.includes(`${PORTAL_COOKIE}=${process.env.ADMIN_PASS}`);
}
function loginPage(msg = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DFH Portal Login</title>
  <style>body{font-family:system-ui,Arial;background:#0d6efd;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{background:#fff;padding:32px;border-radius:14px;box-shadow:0 8px 30px #0003;width:300px}
  h2{margin:0 0 18px}input{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
  button{width:100%;padding:11px;background:#0d6efd;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer;margin-top:8px}
  .err{color:#c00;font-size:13px}</style></head><body>
  <form class="box" method="POST" action="/portal/login">
    <h2>🏥 DFH Portal</h2>
    <div class="err">${msg}</div>
    <input name="user" placeholder="Username" autocomplete="off">
    <input name="pass" type="password" placeholder="Password">
    <button>Login</button>
  </form></body></html>`;
}

app.post("/portal/login", (req, res) => {
  if (req.body.user === process.env.ADMIN_USER && req.body.pass === process.env.ADMIN_PASS) {
    res.setHeader("Set-Cookie", `${PORTAL_COOKIE}=${process.env.ADMIN_PASS}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/portal");
  }
  res.send(loginPage("Galat username ya password"));
});

app.get("/portal/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${PORTAL_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect("/portal");
});

// Main portal: stats + department analytics + conversation list
// ===== JSON API for the app UI =====
app.get("/portal/api/stats", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  res.json(getStats());
});

app.get("/portal/api/conversations", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const convos = getConversations().map((c) => {
    const lead = getPatientLead(c.whatsapp_number);
    return {
      number: c.whatsapp_number,
      last: cleanForDisplay(c.last || ""),
      time: c.time,
      count: c.count,
      name: lead?.patient_name || "",
      department: lead?.department || "",
      needs_human: lead?.needs_human || false,
    };
  });
  res.json(convos);
});

// Clean a message for display: remove internal tags/notes that should
// never be shown (voice-transcription notes, META leftovers, etc.)
function cleanForDisplay(text) {
  if (!text) return "";
  return text
    .replace(/<+\s*\/?\s*META\s*>+/gi, "")
    .replace(/\{[\s\S]*?"(?:intent|department|lead_complete)"[\s\S]*?\}/g, "")
    // remove our internal parenthetical voice/image notes (Urdu)
    .replace(/\(مریض نے وائس میسج بھیجا[^)]*\)/g, "")
    .replace(/\(اگر اس میں نام[^)]*\)/g, "")
    .replace(/\(مریض نے ایک تصویر[^)]*\)/g, "")
    .replace(/\(یاد رہے[^)]*\)/g, "")
    .replace(/\(صرف آپ کی معلومات کے لیے[^)]*\)/g, "")
    .replace(/^\s*\(.*?ٹیکسٹ میں یہ بنا:\)\s*/g, "")
    .trim();
}

app.get("/portal/api/chat/:number", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const number = req.params.number;
  const messages = getConversation(number).map((m) => ({
    role: m.role,
    content: cleanForDisplay(m.content),
    created_at: m.created_at,
  }));
  res.json({ number, messages, lead: getPatientLead(number) || null });
});

// Leads view — ONLY leads actually forwarded to managers (confirmed, complete).
app.get("/portal/api/leads", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const leads = getForwardedLeads().map((l) => ({
    number: l.whatsapp_number,
    name: l.patient_name || "",
    department: l.department,
    inquiry: cleanForDisplay(l.summary || "").slice(0, 80),
    time: l.created_at,
  }));
  res.json(leads);
});

// Search messages by word (across all conversations).
app.get("/portal/api/search", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const q = (req.query.q || "").toString().toLowerCase().trim();
  if (!q) return res.json([]);
  const convos = getConversations();
  const out = [];
  for (const c of convos) {
    const msgs = getConversation(c.whatsapp_number);
    const hit = msgs.find((m) => (m.content || "").toLowerCase().includes(q));
    if (hit) {
      const lead = getPatientLead(c.whatsapp_number);
      out.push({
        number: c.whatsapp_number,
        name: lead?.patient_name || "",
        snippet: cleanForDisplay(hit.content).slice(0, 60),
        time: c.time,
      });
    }
  }
  res.json(out);
});

// Manifest for installable app (PWA)
app.get("/portal/manifest.json", (req, res) => {
  res.json({
    name: "DFH Admin",
    short_name: "DFH",
    start_url: "/portal",
    display: "standalone",
    background_color: "#111b21",
    theme_color: "#075e54",
    icons: [
      { src: "https://cdn-icons-png.flaticon.com/192/3departments.png", sizes: "192x192", type: "image/png" },
    ],
  });
});

// Main portal — WhatsApp-style single-page app
app.get("/portal", (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  res.send(portalApp());
});

// Send a manual reply (JSON)
app.post("/portal/reply", async (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const { number, text } = req.body;
  if (number && text) {
    const to = number.replace(/^\+/, "");
    try {
      await sendText(to, text);
      saveMessage(number, "assistant", text);
      return res.json({ ok: true });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  }
  res.json({ ok: false, error: "missing data" });
});

app.get("/dashboard", (req, res) => res.redirect("/portal"));

// The WhatsApp-style app HTML
function portalApp() {
  return `<!doctype html><html lang="ur"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>DFH Admin</title>
<link rel="manifest" href="/portal/manifest.json">
<meta name="theme-color" content="#075e54">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b141a;color:#e9edef;height:100vh;overflow:hidden}
.urdu,.bubble,.last,.cname{font-family:"Noto Nastaliq Urdu",-apple-system,"Segoe UI",sans-serif;line-height:2.1}
#app{height:100vh;display:flex;flex-direction:column;max-width:1000px;margin:0 auto;background:#111b21}
.top{background:#202c33;color:#e9edef;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:1px solid #2a3942}
.top h1{font-size:17px;font-weight:600}
.top .acts{display:flex;align-items:center;gap:6px}
.iconbtn{background:#2a3942;border:none;color:#aebac1;font-size:16px;cursor:pointer;width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;text-decoration:none}
.iconbtn:hover{background:#374248}
.tabs{display:flex;background:#111b21;flex-shrink:0;border-bottom:1px solid #2a3942}
.tab{flex:1;text-align:center;padding:12px;font-size:13px;font-weight:600;color:#8696a0;cursor:pointer;border-bottom:3px solid transparent}
.tab.active{color:#00a884;border-bottom-color:#00a884}
.stats{display:flex;gap:8px;padding:10px;background:#0b141a;overflow-x:auto;flex-shrink:0}
.stat{background:#202c33;border-radius:10px;padding:8px 14px;min-width:84px;text-align:center}
.stat .n{font-size:20px;font-weight:700;color:#00a884}
.stat .l{font-size:11px;color:#8696a0}
.search{padding:8px 10px;background:#111b21;flex-shrink:0}
.search input{width:100%;padding:10px 16px;border-radius:8px;border:none;background:#202c33;color:#e9edef;font-size:14px;outline:none}
.filters{display:flex;gap:6px;padding:0 10px 10px;background:#111b21;overflow-x:auto;flex-shrink:0}
.chip{background:#202c33;color:#8696a0;border:none;padding:6px 13px;border-radius:16px;font-size:12px;white-space:nowrap;cursor:pointer}
.chip.active{background:#00a884;color:#fff}
.list{flex:1;overflow-y:auto;background:#111b21}
.conv{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #202c33;cursor:pointer;gap:12px}
.conv:hover{background:#202c33}
.avatar{width:48px;height:48px;border-radius:50%;background:#6a7175;display:flex;align-items:center;justify-content:center;font-size:20px;color:#cfd6da;flex-shrink:0}
.conv .meta{flex:1;min-width:0}
.conv .row1{display:flex;justify-content:space-between;align-items:center}
.conv .name{font-size:15px;font-weight:500;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv .time{font-size:11px;color:#8696a0;flex-shrink:0;margin-left:8px}
.conv .row2{display:flex;justify-content:space-between;align-items:center;margin-top:3px;gap:6px}
.conv .last{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;direction:rtl;text-align:right;line-height:1.8}
.badge{font-size:10px;padding:2px 8px;border-radius:10px;color:#fff;flex-shrink:0}
.b-pharmacy{background:#00a884}.b-lab{background:#2196f3}.b-aesthetic{background:#ff4da6}.b-appointment{background:#e53935}.b-online{background:#7c4dff}.b-nursing{background:#ff9800}.b-physio{background:#00bcd4}.b-general{background:#6a7175}
.needs{background:#ff5252;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;flex-shrink:0}
.unread{background:#00a884;color:#fff;font-size:11px;font-weight:600;min-width:20px;height:20px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;flex-shrink:0}
.empty{text-align:center;color:#8696a0;padding:40px 20px;font-size:14px}
.chatview{position:fixed;inset:0;background:#0b141a;display:none;flex-direction:column;max-width:1000px;margin:0 auto;z-index:10}
.chatview.open{display:flex}
.chead{background:#202c33;padding:10px 14px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.chead .back{color:#00a884;font-size:24px;cursor:pointer;background:none;border:none}
.chead .ci{flex:1;min-width:0}
.chead .cname{font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chead .cnum{font-size:12px;color:#8696a0}
.leadbar{background:#182229;padding:7px 14px;font-size:12px;color:#8696a0;flex-shrink:0;border-bottom:1px solid #202c33;direction:rtl;text-align:right}
.msgs{flex:1;overflow-y:auto;padding:14px 8%;background:#0b141a}
.bubble{max-width:75%;padding:7px 12px 8px;border-radius:8px;font-size:15px;margin:5px 0;word-wrap:break-word;direction:rtl;text-align:right;unicode-bidi:plaintext}
.bot{background:#005c4b;margin-left:auto;border-top-right-radius:0}
.user{background:#202c33;margin-right:auto;border-top-left-radius:0}
.btime{font-size:10px;color:#8696a099;display:block;text-align:left;margin-top:2px}
.composer{display:flex;gap:8px;padding:10px;background:#202c33;flex-shrink:0;align-items:center}
.composer input{flex:1;padding:11px 16px;border-radius:22px;border:none;background:#2a3942;color:#e9edef;font-size:15px;outline:none;direction:rtl;text-align:right}
.composer button{width:46px;height:46px;border-radius:50%;background:#00a884;border:none;color:#fff;font-size:18px;cursor:pointer;flex-shrink:0}
.note{font-size:11px;color:#8696a0;text-align:center;padding:4px 8px}
.soundmenu{position:absolute;top:54px;right:10px;background:#233138;border-radius:10px;box-shadow:0 4px 20px #0008;padding:6px;z-index:30;display:none}
.soundmenu.open{display:block}
.soundmenu button{display:block;width:140px;text-align:right;background:none;border:none;color:#e9edef;padding:10px 14px;font-size:14px;cursor:pointer;border-radius:8px}
.soundmenu button:hover{background:#2a3942}
.soundmenu button.sel{color:#00a884;font-weight:700}
</style></head><body>
<div id="app">
  <div class="top">
    <h1>🏥 DFH Admin</h1>
    <div class="acts">
      <button class="iconbtn" id="soundBtn">🔔</button>
      <a class="iconbtn" href="/portal/campaign" title="Campaign">📣</a>
      <a class="iconbtn" href="/portal/logout" title="Logout">⎋</a>
    </div>
  </div>
  <div class="soundmenu" id="soundMenu">
    <button data-lvl="loud">🔊 Loud</button>
    <button data-lvl="soft">🔉 Soft</button>
    <button data-lvl="off">🔕 Off</button>
  </div>
  <div class="tabs">
    <div class="tab active" data-tab="chats">💬 Conversations</div>
    <div class="tab" data-tab="leads">✅ Leads sent</div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="search"><input id="search" placeholder="🔍 Search name, number, or any word..."></div>
  <div class="filters" id="filters">
    <button class="chip active" data-dept="">All</button>
    <button class="chip" data-dept="pharmacy">Pharmacy</button>
    <button class="chip" data-dept="lab">Lab</button>
    <button class="chip" data-dept="aesthetic">Aesthetic</button>
    <button class="chip" data-dept="appointment">Appointment</button>
    <button class="chip" data-dept="online">Online Dr</button>\n    <button class="chip" data-dept="nursing">Nursing</button>\n    <button class="chip" data-dept="physio">Physio</button>
  </div>
  <div class="list" id="list"><div class="empty">Loading...</div></div>
</div>

<div class="chatview" id="chatview">
  <div class="chead">
    <button class="back" id="backBtn">&#8592;</button>
    <div class="avatar" id="cAvatar"></div>
    <div class="ci"><div class="cname urdu" id="cName"></div><div class="cnum" id="cNum"></div></div>
  </div>
  <div class="leadbar urdu" id="leadbar"></div>
  <div class="msgs" id="msgs"></div>
  <div class="composer">
    <input id="replyInput" class="urdu" placeholder="جواب لکھیں...">
    <button id="sendBtn">&#10148;</button>
  </div>
  <div class="note">WhatsApp allows free replies only within 24h of the patient's last message.</div>
</div>

<script>
var allConvos=[], allLeads=[], curDept="", curNumber=null, searchText="", curTab="chats";
var lastSeen={}, firstLoad=true;
var soundLevel = localStorage.getItem("dfh_sound") || "loud";

function initial(name,num){ return (name&&name[0]?name[0]:(num||"?").slice(-2,-1)).toUpperCase(); }
function timeStr(t){ try{return new Date(t).toLocaleString("en-GB",{timeZone:"Asia/Karachi",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"});}catch(e){return"";} }
function esc(s){ return (s||"").replace(/[<>]/g,function(c){return c==="<"?"&lt;":"&gt;";}); }

var audioCtx=null;
function ensureAudio(){ try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();}catch(e){} }
function beep(isLead){
  if(soundLevel==="off")return; ensureAudio(); if(!audioCtx)return;
  var vol = soundLevel==="loud"?1.0:0.3;
  function tone(freq,start,dur,v){
    var o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.frequency.value=freq;o.type="sine";
    g.gain.setValueAtTime(v,audioCtx.currentTime+start);
    g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+start+dur);
    o.connect(g);g.connect(audioCtx.destination);
    o.start(audioCtx.currentTime+start);o.stop(audioCtx.currentTime+start+dur);
  }
  if(isLead){tone(880,0,0.2,vol);tone(1100,0.22,0.28,vol);tone(1320,0.5,0.3,vol);}
  else{tone(780,0,0.18,vol);tone(980,0.2,0.2,vol);}
}
function setSoundIcon(){ document.getElementById("soundBtn").textContent = soundLevel==="off"?"🔕":(soundLevel==="soft"?"🔉":"🔊"); }
function markSound(){ var b=document.querySelectorAll("#soundMenu button"); for(var i=0;i<b.length;i++) b[i].className=(b[i].getAttribute("data-lvl")===soundLevel)?"sel":""; }
document.getElementById("soundBtn").onclick=function(e){ e.stopPropagation(); document.getElementById("soundMenu").classList.toggle("open"); markSound(); ensureAudio(); };
(function(){ var btns=document.querySelectorAll("#soundMenu button"); for(var i=0;i<btns.length;i++){ btns[i].onclick=function(){ soundLevel=this.getAttribute("data-lvl"); localStorage.setItem("dfh_sound",soundLevel); setSoundIcon(); document.getElementById("soundMenu").classList.remove("open"); ensureAudio(); if(soundLevel!=="off")beep(false); }; } })();
document.addEventListener("click",function(){ document.getElementById("soundMenu").classList.remove("open"); });
setSoundIcon();

(function(){ var tabs=document.querySelectorAll(".tab"); for(var i=0;i<tabs.length;i++){ tabs[i].onclick=function(){ curTab=this.getAttribute("data-tab"); var t=document.querySelectorAll(".tab"); for(var j=0;j<t.length;j++)t[j].classList.toggle("active",t[j].getAttribute("data-tab")===curTab); document.getElementById("filters").style.display=curTab==="chats"?"flex":"none"; if(curTab==="leads")renderLeads(); else renderList(); }; } })();

async function loadStats(){
  try{var s=await (await fetch("/portal/api/stats")).json();
    document.getElementById("stats").innerHTML=
      '<div class="stat"><div class="n">'+s.total+'</div><div class="l">Inquiries</div></div>'+
      '<div class="stat"><div class="n">'+s.pending+'</div><div class="l">Pending</div></div>'+
      '<div class="stat"><div class="n">'+allLeads.length+'</div><div class="l">Leads sent</div></div>'+
      '<div class="stat"><div class="n">'+allConvos.length+'</div><div class="l">Chats</div></div>';
  }catch(e){}
}
async function loadLeads(){ try{ allLeads=await (await fetch("/portal/api/leads")).json(); }catch(e){} }

async function loadConvos(){
  try{
    var convos=await (await fetch("/portal/api/conversations")).json();
    var newMsg=false,newLead=false,i,c;
    for(i=0;i<convos.length;i++){ c=convos[i];
      var prev=lastSeen[c.number];
      if(prev!==undefined&&c.count>prev){ c._unread=(c._unread||0)+(c.count-prev); newMsg=true; if(c.needs_human)newLead=true; }
      var ex=allConvos.filter(function(x){return x.number===c.number;})[0];
      if(ex&&ex._unread&&c.number!==curNumber) c._unread=Math.max(c._unread||0,ex._unread);
      if(c.number===curNumber) c._unread=0;
    }
    allConvos=convos;
    await loadLeads();
    if(!firstLoad&&newMsg) beep(newLead);
    firstLoad=false;
    for(i=0;i<convos.length;i++){ c=convos[i]; if(lastSeen[c.number]===undefined||c.number===curNumber)lastSeen[c.number]=c.count; else if(c.count>lastSeen[c.number])lastSeen[c.number]=c.count; }
    if(curTab==="chats")renderList(); else renderLeads();
    loadStats();
  }catch(e){}
}

function convRow(number,name,time,last,badgeDept,needs,unread){
  var badge=badgeDept?'<span class="badge b-'+badgeDept+'">'+badgeDept+'</span>':'';
  var nd=needs?'<span class="needs">🔴 Needs reply</span>':'';
  var ur=(unread>0)?'<span class="unread">'+unread+'</span>':'';
  return '<div class="conv" data-num="'+encodeURIComponent(number)+'">'+
    '<div class="avatar">'+initial(name,number)+'</div>'+
    '<div class="meta"><div class="row1"><span class="name">'+esc(name||number)+'</span>'+
    '<span class="time">'+timeStr(time)+'</span></div>'+
    '<div class="row2"><span class="last urdu">'+esc((last||"").slice(0,46))+'</span>'+badge+nd+ur+'</div></div></div>';
}
function bindRows(){ var rows=document.querySelectorAll(".conv"); for(var i=0;i<rows.length;i++){ rows[i].onclick=function(){ openChat(this.getAttribute("data-num")); }; } }

async function renderList(){
  if(searchText){
    try{
      var res=await (await fetch("/portal/api/search?q="+encodeURIComponent(searchText))).json();
      var el=document.getElementById("list");
      if(res.length===0){ el.innerHTML='<div class="empty">No matches</div>'; return; }
      el.innerHTML=res.map(function(r){ return convRow(r.number,r.name,r.time,r.snippet,"",false,0); }).join("");
      bindRows(); return;
    }catch(e){}
  }
  var list=allConvos;
  if(curDept) list=list.filter(function(c){return c.department===curDept;});
  var el2=document.getElementById("list");
  if(list.length===0){ el2.innerHTML='<div class="empty">No conversations</div>'; return; }
  el2.innerHTML=list.map(function(c){ return convRow(c.number,c.name,c.time,c.last,c.department,c.needs_human,c._unread); }).join("");
  bindRows();
}
function renderLeads(){
  var list=allLeads;
  if(searchText){ var q=searchText.toLowerCase(); list=list.filter(function(l){return (l.name||"").toLowerCase().indexOf(q)>=0||(l.number||"").indexOf(q)>=0;}); }
  var el=document.getElementById("list");
  if(list.length===0){ el.innerHTML='<div class="empty">No leads sent to managers yet</div>'; return; }
  el.innerHTML=list.map(function(l){ return convRow(l.number,l.name,l.time,l.inquiry,l.department,false,0); }).join("");
  bindRows();
}

async function openChat(num){
  curNumber=decodeURIComponent(num);
  var c=allConvos.filter(function(x){return x.number===curNumber;})[0]; if(c)c._unread=0;
  var d=await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json();
  document.getElementById("cAvatar").textContent=initial(d.lead&&d.lead.patient_name,curNumber);
  document.getElementById("cName").textContent=(d.lead&&d.lead.patient_name)||curNumber;
  document.getElementById("cNum").textContent=curNumber;
  document.getElementById("leadbar").textContent=d.lead?
    ("شعبہ: "+(d.lead.department||"-")+(d.lead.needs_human?"  •  🔴 جواب درکار":"")):"ابھی کوئی لیڈ معلومات نہیں";
  renderMsgs(d.messages);
  if(c)lastSeen[curNumber]=c.count;
  if(curTab==="chats")renderList();
  document.getElementById("chatview").classList.add("open");
}
function renderMsgs(msgs){
  var el=document.getElementById("msgs");
  if(!msgs||msgs.length===0){ el.innerHTML='<div class="empty">No messages</div>'; return; }
  el.innerHTML=msgs.map(function(m){ return '<div class="bubble '+(m.role==="assistant"?"bot":"user")+'">'+esc(m.content)+'<span class="btime">'+timeStr(m.created_at)+'</span></div>'; }).join("");
  el.scrollTop=el.scrollHeight;
}
document.getElementById("backBtn").onclick=function(){ document.getElementById("chatview").classList.remove("open"); curNumber=null; if(curTab==="chats")renderList(); };
async function sendReply(){
  var inp=document.getElementById("replyInput"); var text=inp.value.trim();
  if(!text||!curNumber)return; inp.value="";
  var r=await (await fetch("/portal/reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:curNumber,text:text})})).json();
  if(r.ok){ var d=await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json(); renderMsgs(d.messages); }
  else alert("Could not send: "+(r.error||"24h window may have passed"));
}
document.getElementById("sendBtn").onclick=sendReply;
document.getElementById("replyInput").onkeydown=function(e){ if(e.key==="Enter")sendReply(); };

var searchTimer;
document.getElementById("search").oninput=function(e){ searchText=e.target.value.trim(); clearTimeout(searchTimer); searchTimer=setTimeout(function(){ if(curTab==="chats")renderList(); else renderLeads(); },300); };
(function(){ var chips=document.querySelectorAll(".chip"); for(var i=0;i<chips.length;i++){ chips[i].onclick=function(){ var ch=document.querySelectorAll(".chip"); for(var j=0;j<ch.length;j++)ch[j].classList.remove("active"); this.classList.add("active"); curDept=this.getAttribute("data-dept"); renderList(); }; } })();

loadConvos();
setInterval(function(){ loadConvos(); if(curNumber)openChatRefresh(); },8000);
async function openChatRefresh(){
  try{var d=await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json();
    if(document.getElementById("chatview").classList.contains("open"))renderMsgs(d.messages);
  }catch(e){}
}
</script></body></html>`;
}

// ---- Campaign page: send a marketing template to existing patients ----
app.get("/portal/campaign", async (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  const patients = await getAllPatients();
  const templates = await getApprovedTemplates();

  const options = templates.length
    ? templates.map((t) => `<option value="${t.name}|${t.language}">${t.name} (${t.category}, ${t.language})</option>`).join("")
    : `<option value="">No approved templates found</option>`;

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Campaign</title>
  <style>body{font-family:system-ui,Arial;margin:0;background:#f6f7f9}
  header{background:#0d6efd;color:#fff;padding:13px 18px;display:flex;justify-content:space-between}
  header a{color:#fff;text-decoration:none}.wrap{max-width:620px;margin:0 auto;padding:22px}
  .card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px #0001}
  input,textarea,select{width:100%;padding:10px;margin:6px 0 14px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
  button{padding:11px 22px;background:#0d6efd;color:#fff;border:0;border-radius:8px;cursor:pointer;font-size:15px}
  .warn{background:#fff3cd;border:1px solid #ffe69c;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px}</style></head><body>
  <header><a href="/portal">← Back</a><b>📣 Campaign</b><span></span></header>
  <div class="wrap"><div class="card">
    <div class="warn">⚠️ This sends an approved template to your <b>${patients.length}</b> existing patients (who messaged you before). Marketing templates cost the marketing rate; utility templates cost the utility rate. Only opted-in patients — never upload outside lists.</div>
    <form method="POST" action="/portal/campaign/send" onsubmit="return confirm('Send to ${patients.length} patients? This will incur charges.')">
      <label>Choose an approved template:</label>
      <select name="template_combo" required>${options}</select>
      <label>Message detail (fills {{1}} if your template has a blank, optional):</label>
      <textarea name="param" rows="3" placeholder="e.g. Free Gynae Camp, 25 June, 10am-2pm. Book now!"></textarea>
      <button>Send Campaign</button>
    </form>
  </div></div></body></html>`);
});

app.post("/portal/campaign/send", async (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  const { template_combo, param } = req.body;
  const [template, lang] = (template_combo || "|en").split("|");
  const result = await runCampaign(template, lang || "en", param || "");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Campaign Sent</title>
  <style>body{font-family:system-ui,Arial;margin:0;background:#f6f7f9}
  .wrap{max-width:500px;margin:60px auto;text-align:center;background:#fff;padding:30px;border-radius:12px;box-shadow:0 1px 4px #0001}
  a{color:#0d6efd}</style></head><body><div class="wrap">
  <h2>📣 Campaign Complete</h2>
  <p>Total patients: <b>${result.total}</b></p>
  <p>✅ Sent: <b>${result.sent}</b></p>
  <p>❌ Failed: <b>${result.failed}</b></p>
  <p><a href="/portal">← Back to portal</a></p>
  </div></body></html>`);
});

// ---- Weekly report: manual trigger for testing (login-protected) ----
// Visit /portal/weekly to run the analysis NOW, see it, and send it to
// the hospital manager's WhatsApp.
app.get("/portal/weekly", async (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  try {
    const report = await runWeeklyAnalysis();
    const sent = await sendWeeklyReport(report);
    await setLastWeeklyReport(new Date().toISOString());
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Weekly Report</title>
    <style>body{font-family:system-ui,Arial;margin:0;background:#f6f7f9}
    .wrap{max-width:640px;margin:40px auto;background:#fff;padding:26px;border-radius:12px;box-shadow:0 1px 4px #0001}
    pre{white-space:pre-wrap;background:#f2f4f7;padding:14px;border-radius:8px;font-size:14px}
    a{color:#0d6efd}</style></head><body><div class="wrap">
    <h2>📊 Weekly Bot Report</h2>
    <p>${sent ? "✅ Sent to hospital manager WhatsApp." : "⚠️ Could not send — check Managers sheet ('appointment' row) and logs."}</p>
    <pre>${report.replace(/</g, "&lt;")}</pre>
    <p><a href="/portal">← Back to portal</a></p></div></body></html>`);
  } catch (e) {
    console.error("weekly report error:", e.message);
    res.status(500).send("Weekly report failed: " + e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Every hour, remove expired conversation rows so the Sheet stays lean.
setInterval(() => {
  cleanupExpired().catch((e) => console.error("cleanup error:", e.message));
}, 60 * 60 * 1000);

// Every 30 minutes: is it Monday 9-10 AM Pakistan time and we haven't
// sent this week's report yet? Then run the weekly conversation analysis
// and WhatsApp it to the hospital manager.
setInterval(async () => {
  try {
    const pk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
    if (pk.getDay() !== 1 || pk.getHours() !== 9) return; // Monday, 9 AM hour only
    const last = getLastWeeklyReport();
    if (last && Date.now() - new Date(last).getTime() < 6 * 24 * 60 * 60 * 1000) return; // already sent this week
    console.log("📊 Running weekly conversation analysis...");
    const report = await runWeeklyAnalysis();
    await sendWeeklyReport(report);
    await setLastWeeklyReport(new Date().toISOString());
    console.log("📊 Weekly report done.");
  } catch (e) {
    console.error("weekly analysis error:", e.message);
  }
}, 30 * 60 * 1000);

// Appointment reminders DISABLED by owner request — the scheduler below
// is intentionally removed (no reminders to patients or managers).
/* setInterval(() => {
  processReminders().catch((e) => console.error("reminder error:", e.message));
}, 15 * 60 * 1000); */
