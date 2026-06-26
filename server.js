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
import { imageToPublicLink } from "./images.js";
import { getPatientMemory, savePatientMemory, getAndClearPatientImage } from "./patients.js";
import { saveCorrection, loadCorrections } from "./corrections.js";
import { forwardLeadToManager } from "./managers.js";
import { loadConversation, saveConversation, clearConversation, cleanupExpired } from "./conversations.js";
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
    let imageLink = ""; // public link if patient sent a photo

    if (message.type === "text") {
      patientText = message.text.body;
    } else if (message.type === "image") {
      // Patient sent a photo. Host it for a public link, then let the
      // CONVERSATION CONTEXT decide the department (don't assume medicine).
      console.log(`🖼️ ${from}: image received, hosting...`);
      try {
        imageLink = await imageToPublicLink(message.image.id);
      } catch (e) {
        console.error("Image host error:", e.message);
      }
      const caption = message.image?.caption || "";
      // Don't claim it's forwarded. Acknowledge receipt, find the right
      // department + confirm, THEN forward with the completed lead.
      patientText = caption
        ? `(مریض نے ایک تصویر بھیجی ہے، ساتھ یہ لکھا:) ${caption}\n(یاد رہے: تصویر کے مواد پر تبصرہ نہ کریں۔ یہ نہ کہیں کہ بھیج دی ہے۔ پہلے درست شعبہ معلوم کریں، باقی معلومات لیں، تصدیق لیں — پھر تصویر confirmed لیڈ کے ساتھ جائے گی)`
        : "(مریض نے ایک تصویر بھیجی ہے۔ تصویر کے مواد پر تبصرہ نہ کریں، اور یہ نہ کہیں کہ منیجر کو بھیج دی ہے۔ پہلے نرمی سے پوچھیں کہ یہ کس بارے میں ہے [دوا یا جلد/بال] اور کیا جاننا چاہتے ہیں، باقی لیڈ معلومات لیں، خلاصہ دکھا کر تصدیق لیں — تصویر تب confirmed لیڈ کے ساتھ خود بخود جائے گی)";
      if (imageLink) {
        // Save the link only (no department assumption).
        await savePatientMemory(fromFormatted, { image_link: imageLink });
        console.log(`🖼️ → hosted: ${imageLink}`);
      }
    } else if (message.type === "audio") {
      wasVoice = true;
      console.log(`🎤 ${from}: voice note received, transcribing...`);
      try {
        patientText = await transcribeVoice(message.audio.id);
        console.log(`🎤 → transcribed: ${patientText}`);
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
        // wrong/missing secret — treat as normal message (don't reveal the secret exists)
        await sendText(from, "معذرت، یہ کمانڈ درست نہیں۔");
      }
      return; // don't run the normal AI flow for a correction command
    }

    // 1. Load hospital knowledge from Google Sheets
    const knowledge = await loadKnowledge();

    // 1a. Load admin corrections and append — Zainab always obeys these
    const corrections = await loadCorrections();
    const knowledgePlus = corrections ? `${knowledge}\n${corrections}` : knowledge;

    // 2. Get recent conversation so the AI remembers context.
    //    Durable (survives restarts) + in-memory fallback.
    let history = await loadConversation(fromFormatted);
    if (!history || history.length === 0) history = getRecentHistory(from);

    // 1b. Returning-patient memory — but ONLY greet "welcome back" on a
    //     FRESH conversation (no active history). Mid-conversation we just
    //     use their known details silently, so she doesn't repeat the
    //     greeting again and again.
    const isFreshConversation = !history || history.length === 0;
    const patientMemory = isFreshConversation
      ? await getPatientMemory(fromFormatted)
      : "";

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

    // 4. Save everything
    saveMessage(from, "user", patientText);
    saveMessage(from, "assistant", reply);
    // Durable save (survives restarts) so an interrupted booking resumes
    await saveConversation(fromFormatted, history, patientText, reply);
    saveLead({
      patient_name: meta.patient_name || profileName,
      whatsapp_number: fromFormatted,
      inquiry: patientText,
      department: meta.department,
      intent: meta.intent,
      needs_human: meta.needs_human,
    });

    // 5. Send the Urdu reply back — UNLESS this is a sales/marketing
    //    pitch the brain flagged to ignore (stay silent, save cost).
    if (meta.stay_silent) {
      console.log(`🤐 ${from}: sales/marketing pitch — staying silent`);
      return;
    }
    await sendText(from, reply);
    console.log(`🤖 → ${from}: ${reply.slice(0, 60)}...`);

    // 5b. ALWAYS remember this patient in the Google Sheet (name +
    //     WhatsApp + address) for future correspondence & campaigns.
    //     Number stored in clean international format (+923...).
    await savePatientMemory(fromFormatted, {
      name: meta.patient_name || profileName || "",
      address: meta.address || "",
      pin_location: meta.pin_location || "",
      last_service: meta.department || "",
    });

    // 6. If the AI says the lead is COMPLETE, prepare the manager summary.
    //    (For now we LOG it so we can test collection. Manager delivery
    //     via WhatsApp template is the next step once this works.)
    if (meta.lead_complete && meta.lead_summary) {
      const dept = meta.department || "general";
      console.log("==================================================");
      console.log(`✅ LEAD COMPLETE → department: ${dept}`);
      console.log(`👤 Patient: ${meta.patient_name || profileName} (${from})`);
      console.log(`📋 Summary for manager:\n${meta.lead_summary}`);
      console.log("==================================================");

      // Forward the lead to the relevant department manager's WhatsApp.
      let fullSummary = `${meta.lead_summary}\nPatient name: ${meta.patient_name || profileName}`;
      // Attach a photo link: either from this message, or one the
      // patient sent earlier in the conversation (saved on their record).
      let leadImage = imageLink;
      if (!leadImage) leadImage = await getAndClearPatientImage(fromFormatted);
      if (leadImage) fullSummary += `\nPatient photo: ${leadImage}`;
      await forwardLeadToManager(dept, fullSummary, fromFormatted);
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
      last: c.last || "",
      time: c.time,
      count: c.count,
      name: lead?.patient_name || "",
      department: lead?.department || "",
      needs_human: lead?.needs_human || false,
    };
  });
  res.json(convos);
});

app.get("/portal/api/chat/:number", (req, res) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: "auth" });
  const number = req.params.number;
  res.json({
    number,
    messages: getConversation(number),
    lead: getPatientLead(number) || null,
  });
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
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>DFH Admin</title>
<link rel="manifest" href="/portal/manifest.json">
<meta name="theme-color" content="#075e54">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#111b21;color:#e9edef;height:100vh;overflow:hidden}
#app{height:100vh;display:flex;flex-direction:column;max-width:900px;margin:0 auto}
.top{background:#075e54;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.top h1{font-size:18px;font-weight:600}
.top .acts a{color:#d9fdd3;text-decoration:none;font-size:13px;margin-left:14px}
.stats{display:flex;gap:8px;padding:10px;background:#0b141a;overflow-x:auto;flex-shrink:0}
.stat{background:#202c33;border-radius:10px;padding:8px 14px;min-width:90px;text-align:center}
.stat .n{font-size:20px;font-weight:700;color:#00a884}
.stat .l{font-size:11px;color:#8696a0}
.search{padding:8px 10px;background:#111b21;flex-shrink:0}
.search input{width:100%;padding:9px 14px;border-radius:20px;border:none;background:#202c33;color:#e9edef;font-size:14px;outline:none}
.filters{display:flex;gap:6px;padding:4px 10px 10px;background:#111b21;overflow-x:auto;flex-shrink:0}
.chip{background:#202c33;color:#8696a0;border:none;padding:6px 13px;border-radius:16px;font-size:12px;white-space:nowrap;cursor:pointer}
.chip.active{background:#00a884;color:#fff}
.list{flex:1;overflow-y:auto;background:#111b21}
.conv{display:flex;align-items:center;padding:11px 14px;border-bottom:1px solid #202c33;cursor:pointer;gap:12px}
.conv:hover{background:#202c33}
.avatar{width:46px;height:46px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;flex-shrink:0}
.conv .meta{flex:1;min-width:0}
.conv .row1{display:flex;justify-content:space-between;align-items:center}
.conv .name{font-size:15px;font-weight:500;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv .time{font-size:11px;color:#8696a0;flex-shrink:0;margin-left:8px}
.conv .row2{display:flex;justify-content:space-between;align-items:center;margin-top:2px}
.conv .last{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;color:#fff;flex-shrink:0;margin-left:6px}
.b-pharmacy{background:#00a884}.b-lab{background:#5b8def}.b-aesthetic{background:#c264fe}.b-appointment{background:#f0a020}
.dot{width:9px;height:9px;border-radius:50%;background:#ff5252;flex-shrink:0;margin-left:6px}
.unread{background:#00a884;color:#fff;font-size:11px;font-weight:600;min-width:20px;height:20px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;margin-left:6px;flex-shrink:0}
/* chat view */
.chatview{position:fixed;inset:0;background:#0b141a;display:none;flex-direction:column;max-width:900px;margin:0 auto;z-index:10}
.chatview.open{display:flex}
.chead{background:#202c33;padding:11px 14px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.chead .back{color:#00a884;font-size:22px;cursor:pointer;background:none;border:none}
.chead .ci{flex:1;min-width:0}
.chead .cname{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chead .cnum{font-size:12px;color:#8696a0}
.leadbar{background:#182229;padding:7px 14px;font-size:12px;color:#8696a0;flex-shrink:0;border-bottom:1px solid #202c33}
.msgs{flex:1;overflow-y:auto;padding:14px;background:#0b141a;background-image:linear-gradient(rgba(11,20,26,.96),rgba(11,20,26,.96))}
.bubble{max-width:78%;padding:8px 12px;border-radius:9px;font-size:14px;margin:4px 0;white-space:pre-wrap;word-wrap:break-word;line-height:1.4}
.bot{background:#005c4b;margin-left:auto;border-top-right-radius:2px}
.user{background:#202c33;margin-right:auto;border-top-left-radius:2px}
.composer{display:flex;gap:8px;padding:10px;background:#202c33;flex-shrink:0;align-items:center}
.composer input{flex:1;padding:11px 16px;border-radius:22px;border:none;background:#2a3942;color:#e9edef;font-size:14px;outline:none}
.composer button{width:46px;height:46px;border-radius:50%;background:#00a884;border:none;color:#fff;font-size:18px;cursor:pointer;flex-shrink:0}
.note{font-size:11px;color:#8696a0;text-align:center;padding:4px}
.empty{text-align:center;color:#8696a0;padding:40px 20px;font-size:14px}
.refreshing{font-size:11px;color:#00a884;text-align:center;padding:4px}
</style></head><body>
<div id="app">
  <div class="top">
    <h1>🏥 DFH Admin</h1>
    <div class="acts"><button id="soundBtn" onclick="toggleSound()" style="background:none;border:none;font-size:18px;cursor:pointer;margin-right:10px">🔔</button><a href="/portal/campaign">📣 Campaign</a><a href="/portal/logout">Logout</a></div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="search"><input id="search" placeholder="🔍 Search name or number..."></div>
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
    <button class="back" onclick="closeChat()">←</button>
    <div class="avatar" id="cAvatar"></div>
    <div class="ci"><div class="cname" id="cName"></div><div class="cnum" id="cNum"></div></div>
  </div>
  <div class="leadbar" id="leadbar"></div>
  <div class="msgs" id="msgs"></div>
  <div class="composer">
    <input id="replyInput" placeholder="Type a reply (within 24h)..." onkeydown="if(event.key==='Enter')sendReply()">
    <button onclick="sendReply()">➤</button>
  </div>
  <div class="note">WhatsApp allows free replies only within 24h of the patient's last message.</div>
</div>

<script>
let allConvos = [], curDept = "", curNumber = null, searchText = "";
let lastSeen = {}; // number -> last message count we've seen
let soundOn = (localStorage.getItem("dfh_sound") !== "off");
let firstLoad = true;

function initial(name, num){ return (name && name[0] ? name[0] : (num||"?").slice(-2,-1)).toUpperCase(); }
function timeStr(t){ try{ return new Date(t).toLocaleString("en-GB",{timeZone:"Asia/Karachi",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"});}catch(e){return"";} }

// --- Notification beep (Web Audio, no file needed) ---
let audioCtx = null;
function beep(isLead){
  if(!soundOn) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const playTone=(freq,start,dur,vol)=>{
      const o=audioCtx.createOscillator(), g=audioCtx.createGain();
      o.frequency.value=freq; o.type="sine";
      g.gain.setValueAtTime(vol, audioCtx.currentTime+start);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+start+dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime+start); o.stop(audioCtx.currentTime+start+dur);
    };
    if(isLead){ // louder, double tone for leads
      playTone(880,0,0.18,0.5); playTone(1100,0.2,0.25,0.6);
    }else{ playTone(760,0,0.15,0.25); }
  }catch(e){}
}

function toggleSound(){
  soundOn=!soundOn;
  localStorage.setItem("dfh_sound", soundOn?"on":"off");
  document.getElementById("soundBtn").textContent = soundOn?"🔔":"🔕";
  if(soundOn){ try{ audioCtx = audioCtx||new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
}

async function loadStats(){
  try{ const s = await (await fetch("/portal/api/stats")).json();
    document.getElementById("stats").innerHTML =
      '<div class="stat"><div class="n">'+s.total+'</div><div class="l">Inquiries</div></div>'+
      '<div class="stat"><div class="n">'+s.pending+'</div><div class="l">Pending</div></div>'+
      '<div class="stat"><div class="n">'+s.needHuman+'</div><div class="l">Need human</div></div>'+
      '<div class="stat"><div class="n">'+allConvos.length+'</div><div class="l">Chats</div></div>';
  }catch(e){}
}

async function loadConvos(){
  try{
    const convos = await (await fetch("/portal/api/conversations")).json();
    // detect new messages for beep + unread
    let newMsg=false, newLead=false;
    for(const c of convos){
      const prev = lastSeen[c.number];
      if(prev!==undefined && c.count>prev){
        c._unread = (c._unread||0) + (c.count-prev);
        newMsg=true; if(c.needs_human) newLead=true;
      }
      // carry forward unread from existing
      const existing = allConvos.find(x=>x.number===c.number);
      if(existing && existing._unread && c.number!==curNumber) c._unread = Math.max(c._unread||0, existing._unread);
      if(c.number===curNumber) c._unread = 0; // open chat = read
    }
    allConvos = convos;
    if(!firstLoad && newMsg) beep(newLead);
    firstLoad=false;
    // update lastSeen baseline
    for(const c of convos){ if(lastSeen[c.number]===undefined||c.number===curNumber) lastSeen[c.number]=c.count; else if(c.count>lastSeen[c.number]) lastSeen[c.number]=c.count; }
    renderList(); loadStats();
  }catch(e){}
}

function renderList(){
  let list = allConvos;
  if(curDept) list = list.filter(c=>c.department===curDept);
  if(searchText){ const q=searchText.toLowerCase();
    list = list.filter(c=>(c.name||"").toLowerCase().includes(q)||(c.number||"").includes(q)); }
  const el = document.getElementById("list");
  if(list.length===0){ el.innerHTML='<div class="empty">No conversations</div>'; return; }
  el.innerHTML = list.map(c=>{
    const badge = c.department ? '<span class="badge b-'+c.department+'">'+c.department+'</span>' : '';
    const dot = c.needs_human ? '<span class="dot"></span>' : '';
    const unread = (c._unread>0) ? '<span class="unread">'+c._unread+'</span>' : '';
    return '<div class="conv" onclick="openChat(\\''+encodeURIComponent(c.number)+'\\')">'+
      '<div class="avatar">'+initial(c.name,c.number)+'</div>'+
      '<div class="meta"><div class="row1"><span class="name">'+(c.name||c.number)+'</span>'+
      '<span class="time">'+timeStr(c.time)+'</span></div>'+
      '<div class="row2"><span class="last">'+(c.last||"").slice(0,40)+'</span>'+badge+dot+unread+'</div></div></div>';
  }).join("");
}

async function openChat(num){
  curNumber = decodeURIComponent(num);
  const c = allConvos.find(x=>x.number===curNumber); if(c) c._unread=0;
  const d = await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json();
  document.getElementById("cAvatar").textContent = initial(d.lead?.patient_name, curNumber);
  document.getElementById("cName").textContent = d.lead?.patient_name || curNumber;
  document.getElementById("cNum").textContent = curNumber;
  document.getElementById("leadbar").textContent = d.lead ?
    ("Dept: "+(d.lead.department||"-")+" | Intent: "+(d.lead.intent||"-")+(d.lead.needs_human?" | 🔴 needs human":"")) : "No lead info yet";
  renderMsgs(d.messages);
  if(c) lastSeen[curNumber]=c.count;
  renderList();
  document.getElementById("chatview").classList.add("open");
}

function renderMsgs(msgs){
  const el = document.getElementById("msgs");
  if(!msgs||msgs.length===0){ el.innerHTML='<div class="empty">No messages</div>'; return; }
  el.innerHTML = msgs.map(m=>'<div class="bubble '+(m.role==="assistant"?"bot":"user")+'">'+
    (m.content||"").replace(/</g,"&lt;")+'</div>').join("");
  el.scrollTop = el.scrollHeight;
}

function closeChat(){ document.getElementById("chatview").classList.remove("open"); curNumber=null; renderList(); }

async function sendReply(){
  const inp = document.getElementById("replyInput");
  const text = inp.value.trim();
  if(!text||!curNumber) return;
  inp.value="";
  const r = await (await fetch("/portal/reply",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({number:curNumber,text})})).json();
  if(r.ok){ const d = await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json(); renderMsgs(d.messages); }
  else { alert("Could not send: "+(r.error||"24h window may have passed")); }
}

document.getElementById("search").oninput = (e)=>{ searchText=e.target.value; renderList(); };
document.querySelectorAll(".chip").forEach(c=>c.onclick=()=>{
  document.querySelectorAll(".chip").forEach(x=>x.classList.remove("active"));
  c.classList.add("active"); curDept=c.dataset.dept; renderList();
});
document.getElementById("soundBtn").textContent = soundOn?"🔔":"🔕";

loadConvos();
setInterval(()=>{ loadConvos(); if(curNumber) openChatRefresh(); }, 8000);
async function openChatRefresh(){
  try{ const d = await (await fetch("/portal/api/chat/"+encodeURIComponent(curNumber))).json();
    if(document.getElementById("chatview").classList.contains("open")) renderMsgs(d.messages);
  }catch(e){}
}
</script>
</body></html>`;
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
