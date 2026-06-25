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
      // Never comment on photo content. Just forward + collect lead info.
      patientText = caption
        ? `(مریض نے ایک تصویر بھیجی ہے، ساتھ یہ لکھا:) ${caption}\n(یاد رہے: تصویر کے مواد پر تبصرہ نہ کریں، صرف کہیں کہ منیجر کو forward کر دی ہے اور باقی معلومات لیں)`
        : "(مریض نے ایک تصویر بھیجی ہے۔ تصویر کے مواد پر تبصرہ نہ کریں۔ صرف کہیں کہ آپ نے یہ منیجر کو forward کر دی ہے، اور گفتگو کے سیاق سے درست شعبے کی باقی معلومات لیں)";
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

    // 1b. Look up if we already know this patient (returning patient memory)
    const patientMemory = await getPatientMemory(fromFormatted);

    // 2. Get recent conversation so the AI remembers context
    const history = getRecentHistory(from);

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
    let brainInput = `(AAJ ki date aur time: ${pktTime} — Pakistan. Hamesha is date/time ka khayal rakhein.)\n\n${patientText}`;
    if (adContext) brainInput = `${adContext}\n\n${brainInput}`;
    if (patientMemory) brainInput = `${patientMemory}\n\n${brainInput}`;
    const { reply, meta } = await askBrain(brainInput, knowledgePlus, history);

    // 4. Save everything
    saveMessage(from, "user", patientText);
    saveMessage(from, "assistant", reply);
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
app.get("/portal", (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  const s = getStats();
  const convos = getConversations();

  const deptRows = s.byDept
    .map((d) => `<tr><td>${d.department}</td><td>${d.c}</td></tr>`).join("");
  const convoRows = convos
    .map((c) => `<tr onclick="location.href='/portal/chat/${encodeURIComponent(c.whatsapp_number)}'" style="cursor:pointer">
      <td>${c.whatsapp_number}</td>
      <td>${(c.last || "").slice(0, 45)}</td>
      <td>${c.count}</td>
      <td>${new Date(c.time).toLocaleString("en-GB", { timeZone: "Asia/Karachi" })}</td>
    </tr>`).join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>DFH Portal</title>
  <style>body{font-family:system-ui,Arial;margin:0;background:#f6f7f9;color:#1a1a1a}
  header{background:#0d6efd;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
  header a{color:#fff;text-decoration:none;font-size:14px}
  .wrap{padding:22px}.cards{display:flex;gap:16px;margin:8px 0 20px;flex-wrap:wrap}
  .card{background:#fff;border-radius:12px;padding:16px 22px;box-shadow:0 1px 4px #0001}
  .card .n{font-size:28px;font-weight:700}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;margin-top:10px}
  th,td{padding:9px 11px;text-align:left;border-bottom:1px solid #eee;font-size:13px}
  th{background:#0d6efd;color:#fff}h3{margin:22px 0 4px}
  .grid{display:grid;grid-template-columns:1fr 2fr;gap:24px}</style></head><body>
  <header><b>🏥 Downtown Family Hospital — Admin Portal</b><span><a href="/portal/campaign" style="color:#fff;margin-right:18px">📣 Campaign</a><a href="/portal/logout">Logout</a></span></header>
  <div class="wrap">
    <div class="cards">
      <div class="card"><div class="n">${s.total}</div>Total inquiries</div>
      <div class="card"><div class="n">${s.pending}</div>Pending leads</div>
      <div class="card"><div class="n">${s.needHuman}</div>Need human</div>
      <div class="card"><div class="n">${convos.length}</div>Conversations</div>
    </div>
    <div class="grid">
      <div>
        <h3>Department-wise</h3>
        <table><tr><th>Department</th><th>Count</th></tr>${deptRows || "<tr><td colspan=2>No data</td></tr>"}</table>
      </div>
      <div>
        <h3>Conversations (click to open)</h3>
        <table><tr><th>Number</th><th>Last message</th><th>Msgs</th><th>Time</th></tr>
        ${convoRows || "<tr><td colspan=4>No conversations yet</td></tr>"}</table>
      </div>
    </div>
  </div></body></html>`);
});

// View one conversation + reply box
app.get("/portal/chat/:number", (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  const number = req.params.number;
  const msgs = getConversation(number);
  const lead = getPatientLead(number);

  const bubbles = msgs.map((m) => {
    const mine = m.role === "assistant";
    return `<div style="display:flex;justify-content:${mine ? "flex-end" : "flex-start"};margin:6px 0">
      <div style="max-width:70%;padding:9px 13px;border-radius:12px;font-size:14px;
      background:${mine ? "#0d6efd" : "#fff"};color:${mine ? "#fff" : "#000"};box-shadow:0 1px 3px #0001;white-space:pre-wrap">${m.content}</div>
    </div>`;
  }).join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Chat ${number}</title>
  <style>body{font-family:system-ui,Arial;margin:0;background:#e9edf2}
  header{background:#0d6efd;color:#fff;padding:13px 18px;display:flex;justify-content:space-between;align-items:center}
  header a{color:#fff;text-decoration:none}.chat{max-width:760px;margin:0 auto;padding:16px}
  .info{background:#fff;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:10px}
  form{display:flex;gap:8px;margin-top:12px}
  input[type=text]{flex:1;padding:11px;border:1px solid #ccc;border-radius:24px}
  button{padding:11px 20px;background:#0d6efd;color:#fff;border:0;border-radius:24px;cursor:pointer}</style></head><body>
  <header><a href="/portal">← Back</a><b>${number}</b><span></span></header>
  <div class="chat">
    <div class="info">${lead ? `Name: ${lead.patient_name || "-"} | Dept: ${lead.department || "-"} | Intent: ${lead.intent || "-"}` : "No lead info yet"}</div>
    ${bubbles || "<p>No messages.</p>"}
    <form method="POST" action="/portal/reply">
      <input type="hidden" name="number" value="${number}">
      <input type="text" name="text" placeholder="Type a reply (within 24h)..." autocomplete="off" required>
      <button>Send</button>
    </form>
    <p style="font-size:12px;color:#888;text-align:center;margin-top:8px">Note: WhatsApp allows free replies only within 24h of the patient's last message.</p>
  </div></body></html>`);
});

// Send a manual reply from the portal
app.post("/portal/reply", async (req, res) => {
  if (!isLoggedIn(req)) return res.send(loginPage());
  const { number, text } = req.body;
  if (number && text) {
    // strip the + for the WhatsApp API (it wants digits only)
    const to = number.replace(/^\+/, "");
    await sendText(to, text);
    saveMessage(number, "assistant", text);
  }
  res.redirect(`/portal/chat/${encodeURIComponent(number)}`);
});

// Keep old /dashboard working (redirect to new portal)
app.get("/dashboard", (req, res) => res.redirect("/portal"));

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
