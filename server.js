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
} from "./database.js";

const app = express();
app.use(express.json());

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

// ---- Simple admin dashboard (just open it in a browser) ----
app.get("/dashboard", (req, res) => {
  const s = getStats();
  const deptRows = s.byDept
    .map((d) => `<tr><td>${d.department}</td><td>${d.c}</td></tr>`)
    .join("");
  const leadRows = s.recent
    .map(
      (l) => `<tr>
        <td>${l.created_at}</td>
        <td>${l.patient_name || "-"}</td>
        <td>${l.whatsapp_number}</td>
        <td>${l.department || "-"}</td>
        <td>${l.intent}</td>
        <td>${l.needs_human ? "🔴 yes" : "no"}</td>
        <td>${(l.inquiry || "").slice(0, 50)}</td>
      </tr>`
    )
    .join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8">
  <title>DFH Receptionist Dashboard</title>
  <style>
    body{font-family:system-ui,Arial;margin:24px;background:#f6f7f9;color:#1a1a1a}
    h1{font-size:22px}
    .cards{display:flex;gap:16px;margin:16px 0}
    .card{background:#fff;border-radius:12px;padding:18px 22px;box-shadow:0 1px 4px #0001}
    .card .n{font-size:30px;font-weight:700}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;margin-top:12px}
    th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee;font-size:13px}
    th{background:#0d6efd;color:#fff}
  </style></head><body>
    <h1>🏥 Downtown Family Hospital — Receptionist Dashboard</h1>
    <div class="cards">
      <div class="card"><div class="n">${s.total}</div>Total inquiries</div>
      <div class="card"><div class="n">${s.pending}</div>Pending leads</div>
      <div class="card"><div class="n">${s.needHuman}</div>Need human</div>
    </div>
    <h3>Department-wise inquiries</h3>
    <table><tr><th>Department</th><th>Count</th></tr>${deptRows || "<tr><td colspan=2>No data yet</td></tr>"}</table>
    <h3>Recent leads</h3>
    <table>
      <tr><th>Time</th><th>Name</th><th>Number</th><th>Dept</th><th>Intent</th><th>Human?</th><th>Inquiry</th></tr>
      ${leadRows || "<tr><td colspan=7>No leads yet</td></tr>"}
    </table>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
