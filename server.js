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

    // 1. Load hospital knowledge from Google Sheets
    const knowledge = await loadKnowledge();

    // 1b. Look up if we already know this patient (returning patient memory)
    const patientMemory = await getPatientMemory(fromFormatted);

    // 2. Get recent conversation so the AI remembers context
    const history = getRecentHistory(from);

    // 3. Ask the AI brain (include patient memory + ad context + current time)
    const pktTime = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Karachi",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    let brainInput = `(ABHI ka time: ${pktTime} — Pakistan)\n\n${patientText}`;
    if (adContext) brainInput = `${adContext}\n\n${brainInput}`;
    if (patientMemory) brainInput = `${patientMemory}\n\n${brainInput}`;
    const { reply, meta } = await askBrain(brainInput, knowledge, history);

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

    // 5. Send the Urdu reply back
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
  <header><b>🏥 Downtown Family Hospital — Admin Portal</b><a href="/portal/logout">Logout</a></header>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
