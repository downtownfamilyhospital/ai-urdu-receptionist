// =========================================================
//  server.js  — THE MAIN PROGRAM (Phase 1)
//  This is the "brain stem" that connects everything:
//  WhatsApp in  →  AI thinks  →  WhatsApp out  +  save lead
// =========================================================

import "dotenv/config";
import express from "express";

import { loadKnowledge } from "./knowledge.js";
import { askBrain } from "./brain.js";
import { sendText } from "./whatsapp.js";
import { transcribeVoice } from "./voice.js";
import { getPatientMemory, savePatientMemory } from "./patients.js";
import { saveCorrection, loadCorrections } from "./corrections.js";
import { forwardLeadToManager } from "./managers.js";
import { loadConversation, saveConversation, clearConversation, cleanupExpired } from "./conversations.js";
import { scheduleReminder, processReminders } from "./reminders.js";
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
} from "./database.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Health check (so you can confirm the server is alive) ----
app.get("/", (req, res) => {
  res.send("AI Urdu Hospital Receptionist is running ✅");
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
    let wasVoice = false;

    if (message.type === "text") {
      patientText = message.text.body;
    } else if (message.type === "image") {
      // We do NOT process photos on this number. Politely tell the patient
      // to describe what they need in text or voice. No hosting/forwarding.
      console.log(`🖼️ ${from}: image received — telling patient we can't view photos`);
      await sendText(
        from,
        "معذرت، اس واٹس ایپ نمبر پر میں تصویر نہیں دیکھ سکتی۔ 🌸 اگر آپ تھوڑی تفصیل text یا voice میں بتا دیں کہ آپ اس تصویر کے بارے میں کیا جاننا چاہتے ہیں، تو میں خوشی سے آپ کی مدد کر دوں گی۔"
      );
      return; // stop here — don't run the AI flow for a photo
    } else if (message.type === "audio") {
      wasVoice = true;
      console.log(`🎤 ${from}: voice note received, transcribing...`);
      try {
        const transcribed = await transcribeVoice(message.audio.id);
        console.log(`🎤 → transcribed: ${transcribed}`);
        // Tag it as voice so Zainab confirms she heard names/numbers right.
        patientText = `(مریض نے وائس میسج بھیجا، جو ٹیکسٹ میں یہ بنا:) ${transcribed}\n(اگر اس میں نام، نمبر، یا پتہ ہو تو نرمی سے تصدیق کریں کہ آپ نے ٹھیک سنا — مریض غلط ہونے پر لکھ کر درست کر سکتا ہے)`;
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
        await savePatientMemory(fromFormatted, { pin_location: pin });
        console.log(`📍 ${from}: location pin saved`);
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

    // 1+2. Load knowledge, corrections, and conversation IN PARALLEL
    //      (independent reads → much faster than one-by-one).
    const [knowledge, corrections, loadedHistory] = await Promise.all([
      loadKnowledge(),
      loadCorrections(),
      loadConversation(fromFormatted),
    ]);
    const knowledgePlus = corrections ? `${knowledge}\n${corrections}` : knowledge;

    let history = loadedHistory;
    if (!history || history.length === 0) history = getRecentHistory(from);

    // 1b. ALWAYS load saved patient details so Zainab never re-asks.
    //     Greeting only on a fresh conversation (no active history).
    const isFreshConversation = !history || history.length === 0;
    const patientMemory = await getPatientMemory(fromFormatted, isFreshConversation);

    // 3. Ask the AI brain (include patient memory + ad context + current time)
    const pktTime = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Karachi",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    let brainInput = `(صرف آپ کی معلومات کے لیے — موجودہ پاکستان وقت: ${pktTime}۔ اسے جواب میں مت لکھیں جب تک پوچھا نہ جائے۔)\n\n${patientText}`;
    if (adContext) brainInput = `${adContext}\n\n${brainInput}`;
    if (patientMemory) brainInput = `${patientMemory}\n\n${brainInput}`;
    const { reply, meta } = await askBrain(brainInput, knowledgePlus, history);

    // If this is a sales/marketing pitch, stay silent (no reply, no saves).
    if (meta.stay_silent) {
      console.log(`🤐 ${from}: sales/marketing pitch — staying silent`);
      return;
    }

    // 4. SEND THE REPLY FIRST so the patient gets a fast response,
    //    THEN do the saves (patient isn't kept waiting on Sheet writes).
    // HARD SAFETY: never let the "my Urdu is weak" apology slip through,
    // no matter what the model or any old correction says.
    let safeReply = reply
      .replace(/میری اردو[^۔\n]*(کم|کمزور|اچھی)[^۔\n]*۔?/g, "")
      .replace(/اردو[^۔\n]*معذرت[^۔\n]*۔?/g, "")
      .replace(/اردو[^۔\n]*معزرت[^۔\n]*۔?/g, "")
      .trim();
    if (!safeReply) safeReply = "جی، بتائیں میں آپ کی کیا مدد کر سکتی ہوں؟ 🌸";
    await sendText(from, safeReply);
    console.log(`🤖 → ${from}: ${safeReply.slice(0, 60)}...`);

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
    await Promise.all([
      saveConversation(fromFormatted, history, patientText, safeReply),
      savePatientMemory(fromFormatted, {
        name: meta.patient_name || "",
        address: meta.address || "",
        pin_location: meta.pin_location || "",
        last_service: meta.department || "",
      }),
    ]);

    // 6. If the AI says the lead is COMPLETE, prepare the manager summary.
    //    (For now we LOG it so we can test collection. Manager delivery
    //     via WhatsApp template is the next step once this works.)
    if (meta.lead_complete && meta.lead_summary) {
      const dept = meta.department || "general";
      console.log("==================================================");
      console.log(`✅ LEAD COMPLETE → department: ${dept}`);
      console.log(`👤 Patient: ${meta.patient_name} (${from})`);
      console.log(`📋 Summary for manager:\n${meta.lead_summary}`);
      console.log("==================================================");

      // Forward the lead to the relevant department manager's WhatsApp.
      let fullSummary = `${meta.lead_summary}\nPatient name: ${meta.patient_name}`;
      await forwardLeadToManager(dept, fullSummary, fromFormatted);
      // Schedule a 3-hour-before reminder if a visit time was captured.
      if (meta.visit_at) {
        await scheduleReminder(fromFormatted, meta.patient_name, meta.lead_summary, meta.visit_at);
      }
      // Lead is done — clear this patient's conversation memory so the
      // Sheet stays lean and the next chat starts fresh.
      await clearConversation(fromFormatted);
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

// Leads view — only completed/forwarded leads (department set).
app.get("/portal/api/leads", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const s = getStats();
  // recent leads that have a department (i.e. real routed leads)
  const leads = (s.recent || [])
    .filter((l) => l.department && l.department !== "")
    .map((l) => ({
      number: l.whatsapp_number,
      name: l.patient_name || "",
      department: l.department,
      inquiry: cleanForDisplay(l.inquiry || "").slice(0, 80),
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
.b-pharmacy{background:#00a884}.b-lab{background:#5b8def}.b-aesthetic{background:#c264fe}.b-appointment{background:#f0a020}.b-general{background:#6a7175}
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Every hour, remove expired conversation rows so the Sheet stays lean.
setInterval(() => {
  cleanupExpired().catch((e) => console.error("cleanup error:", e.message));
}, 60 * 60 * 1000);

// Every 15 minutes, check for appointments ~3h away and send reminders.
setInterval(() => {
  processReminders().catch((e) => console.error("reminder error:", e.message));
}, 15 * 60 * 1000);
