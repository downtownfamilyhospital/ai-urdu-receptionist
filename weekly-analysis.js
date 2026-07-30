// =========================================================
//  weekly-analysis.js — WEEKLY CONVERSATION AUTO-ANALYSIS
//  Every Monday ~9:00 AM Pakistan time (checked by a scheduler
//  in server.js), this module:
//    1. Pulls the last 7 days of patient conversations + leads
//    2. Asks the AI: why did patients leave? what confused the
//       bot? what should we improve?
//    3. WhatsApps a short, actionable report to the Hospital
//       Manager (the "appointment" department in the Managers
//       sheet) — plain text first, lead-template as fallback.
//  Manual trigger for testing: GET /portal/weekly (logged in).
// =========================================================

import OpenAI from "openai";
import axios from "axios";
import { getManagerNumbers, forwardLeadToManager } from "./managers.js";
import { getMessagesSince, getForwardedSince } from "./database.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000, maxRetries: 2 });

// Build a compact digest of the week's conversations that fits in one
// affordable AI call: up to 40 patients, last 12 messages each, each
// message trimmed to 220 chars.
function buildDigest() {
  const msgs = getMessagesSince(7);
  const byPatient = {};
  for (const m of msgs) {
    (byPatient[m.whatsapp_number] ||= []).push(m);
  }
  const patients = Object.entries(byPatient).slice(-40); // most recent 40
  const lines = [];
  for (const [num, list] of patients) {
    const tail = list.slice(-12);
    lines.push(`--- Patient ${num.slice(-4)} (${list.length} msgs) ---`);
    for (const m of tail) {
      const who = m.role === "user" ? "PATIENT" : "BOT";
      lines.push(`${who}: ${(m.content || "").replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  return { digest: lines.join("\n"), patientCount: Object.keys(byPatient).length, msgCount: msgs.length };
}

export async function runWeeklyAnalysis() {
  const { digest, patientCount, msgCount } = buildDigest();
  const forwarded = getForwardedSince(7);
  const byDept = {};
  for (const f of forwarded) byDept[f.department || "?"] = (byDept[f.department || "?"] || 0) + 1;
  const leadLine = Object.entries(byDept).map(([d, c]) => `${d}: ${c}`).join(", ") || "none";

  if (msgCount === 0) {
    return `📊 *DFH Weekly Bot Report*\nNo patient conversations in the last 7 days.`;
  }

  const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const isGpt5 = /^gpt-5/i.test(MODEL);
  const params = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a quality analyst for a hospital's Urdu WhatsApp receptionist bot (Zainab, Downtown Family Hospital, Islamabad). " +
          "You will receive one week of conversation excerpts. Analyze them and write a SHORT report in simple English for the hospital manager. " +
          "Cover, briefly: 1) Drop-offs — how many patients left mid-booking and the top reasons why; " +
          "2) Bot problems — questions the bot answered poorly, repeated itself on, or could not answer; " +
          "3) Top 3-5 concrete improvement suggestions (knowledge to add, workflow fixes, new services patients asked for). " +
          "Use short bullet lines with WhatsApp *bold* markers. Maximum 850 characters TOTAL. No preamble, start directly with the findings.",
      },
      { role: "user", content: `LEADS FORWARDED THIS WEEK: ${leadLine}\n\nCONVERSATIONS:\n${digest.slice(0, 90000)}` },
    ],
  };
  if (isGpt5) { params.max_completion_tokens = 1200; params.reasoning_effort = "low"; }
  else { params.max_tokens = 500; params.temperature = 0.3; }

  let analysis = "";
  try {
    const completion = await openai.chat.completions.create(params);
    analysis = (completion.choices[0].message.content || "").trim();
  } catch (e) {
    // Param safety net (same as brain.js): retry once with minimal params.
    if (e?.status === 400 && /unsupported|unrecognized|unknown parameter|not supported/i.test(e?.message || "")) {
      delete params.temperature; delete params.reasoning_effort;
      if (params.max_tokens) { params.max_completion_tokens = params.max_tokens; delete params.max_tokens; }
      const completion = await openai.chat.completions.create(params);
      analysis = (completion.choices[0].message.content || "").trim();
    } else {
      throw e;
    }
  }

  const report =
    `📊 *DFH Weekly Bot Report*\n` +
    `🗓 Last 7 days — Patients: ${patientCount}, Messages: ${msgCount}\n` +
    `✅ Leads forwarded: ${leadLine}\n\n` +
    `${analysis}`;

  return report;
}

// Send the report to every Hospital Manager number ("appointment" dept in
// the Managers sheet). Plain text first (free-form, keeps line breaks);
// if that fails (24h window closed), fall back to the approved lead
// template so it always delivers.
export async function sendWeeklyReport(report) {
  const numbers = await getManagerNumbers("appointment");
  if (numbers.length === 0) {
    console.log("⚠️ Weekly report: no hospital manager number found (Managers sheet, department 'appointment')");
    return false;
  }
  // Direct API call (NOT whatsapp.js sendText — that swallows errors, and
  // we need to know when the 24h window blocks us so the template fallback fires).
  let sent = false;
  for (const to of numbers) {
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to, type: "text", text: { body: report } },
        { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`📊 Weekly report sent to manager ${to} (plain text)`);
      sent = true;
    } catch (e) {
      console.error(`⚠️ Weekly report plain-text failed for ${to}:`, JSON.stringify(e.response?.data?.error || e.message));
    }
  }
  if (!sent) {
    // Template fallback — guaranteed delivery via the approved lead template.
    await forwardLeadToManager("appointment", report, "WEEKLY BOT REPORT");
    sent = true;
  }
  return sent;
}
