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
    const message = entry?.messages?.[0];
    if (!message) return; // could be a status update, ignore

    const from = message.from;               // patient's WhatsApp number
    const profileName = entry?.contacts?.[0]?.profile?.name || "";

    // Phase 1 handles TEXT only. (Voice arrives in Phase 2.)
    if (message.type !== "text") {
      await sendText(
        from,
        "السلام علیکم! ابھی میں صرف ٹیکسٹ پیغامات سمجھ سکتی ہوں۔ براہِ کرم اپنا سوال لکھ کر بھیج دیں۔ شکریہ۔"
      );
      return;
    }

    const patientText = message.text.body;
    console.log(`📩 ${from}: ${patientText}`);

    // 1. Load hospital knowledge from Google Sheets
    const knowledge = await loadKnowledge();

    // 2. Get recent conversation so the AI remembers context
    const history = getRecentHistory(from);

    // 3. Ask the AI brain
    const { reply, meta } = await askBrain(patientText, knowledge, history);

    // 4. Save everything
    saveMessage(from, "user", patientText);
    saveMessage(from, "assistant", reply);
    saveLead({
      patient_name: meta.patient_name || profileName,
      whatsapp_number: from,
      inquiry: patientText,
      department: meta.department,
      intent: meta.intent,
      needs_human: meta.needs_human,
    });

    // 5. Send the Urdu reply back
    await sendText(from, reply);
    console.log(`🤖 → ${from}: ${reply.slice(0, 60)}...`);
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
