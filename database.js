// =========================================================
//  database.js
//  Stores leads (every patient inquiry) and short
//  conversation history. Uses a simple JSON file (lowdb) —
//  no compiling needed, installs instantly, works on Railway.
// =========================================================

import { JSONFilePreset } from "lowdb/node";

// Create / open the data file with starting structure.
const db = await JSONFilePreset("hospital.json", { leads: [], messages: [], forwarded: [], deptState: {} });
if (!db.data.forwarded) db.data.forwarded = []; // migrate older files
if (!db.data.deptState) db.data.deptState = {}; // active department per patient
if (!db.data.lastSeen) db.data.lastSeen = {}; // last activity per patient (5-min session reset)
if (!db.data.langState) db.data.langState = {}; // "ur" | "en" per patient
if (!db.data.menuCount) db.data.menuCount = {}; // how many times home menu shown (welcome variants)
if (!db.data.collected) db.data.collected = {}; // captured booking fields per patient (never re-ask)
if (!db.data.lastWeeklyReport) db.data.lastWeeklyReport = ""; // ISO time of last weekly analysis
if (!db.data.pendingAd) db.data.pendingAd = {}; // ad context parked while patient picks a language
if (!db.data.videoSent) db.data.videoSent = {}; // tutorial video sent-once tracker
if (!db.data.awaitingPayment) db.data.awaitingPayment = {}; // payment-screenshot pending since

function nowISO() {
  return new Date().toISOString();
}

// CRITICAL: normalize every WhatsApp number to ONE canonical format
// (923xxxxxxxxx — digits only, 0→92) so the same patient is never split
// across formats and DIFFERENT patients are never mixed. Used on every
// store and every lookup.
function normNum(num) {
  let n = (num || "").replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "92" + n.slice(1); // 03xx → 923xx
  else if (n.startsWith("3") && n.length === 10) n = "92" + n; // bare 3001234567 → 923001234567
  if (n.startsWith("920")) n = "92" + n.slice(3); // 9203xx typo → 923xx
  return n;
}

export async function saveLead({ patient_name, whatsapp_number, inquiry, department, intent, needs_human }) {
  db.data.leads.push({
    id: db.data.leads.length + 1,
    patient_name: patient_name || "",
    whatsapp_number: normNum(whatsapp_number),
    inquiry,
    department: department || "",
    intent: intent || "general",
    needs_human: needs_human ? 1 : 0,
    status: "new",
    created_at: nowISO(),
  });
  await db.write();
}

export async function saveMessage(whatsapp_number, role, content) {
  db.data.messages.push({
    whatsapp_number: normNum(whatsapp_number),
    role,
    content,
    created_at: nowISO(),
  });
  await db.write();
}

// Get the last few messages so the AI remembers the conversation.
export function getRecentHistory(whatsapp_number, limit = 12) {
  const key = normNum(whatsapp_number);
  const all = db.data.messages.filter((m) => normNum(m.whatsapp_number) === key);
  return all.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}

// Simple stats for the dashboard.
// Get a list of all patients who have messaged, with their last message + time.
export function getConversations() {
  const byNumber = {};
  for (const m of db.data.messages) {
    const key = normNum(m.whatsapp_number);
    if (!byNumber[key]) {
      byNumber[key] = { whatsapp_number: key, last: m.content, time: m.created_at, count: 0 };
    }
    byNumber[key].last = m.content;
    byNumber[key].time = m.created_at;
    byNumber[key].count++;
  }
  return Object.values(byNumber).sort((a, b) => (a.time < b.time ? 1 : -1));
}

// Get the full conversation for one patient number.
export function getConversation(whatsapp_number) {
  const key = normNum(whatsapp_number);
  return db.data.messages
    .filter((m) => normNum(m.whatsapp_number) === key)
    .map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
}

// Get stats for one patient number (most recent lead info).
export function getPatientLead(whatsapp_number) {
  const key = normNum(whatsapp_number);
  const leads = db.data.leads.filter((l) => normNum(l.whatsapp_number) === key);
  return leads.length ? leads[leads.length - 1] : null;
}

export function getStats() {
  const leads = db.data.leads;
  const total = leads.length;
  const pending = leads.filter((l) => l.status === "new").length;
  const needHuman = leads.filter((l) => l.needs_human === 1).length;

  const deptCounts = {};
  for (const l of leads) {
    if (l.department && l.department !== "") {
      deptCounts[l.department] = (deptCounts[l.department] || 0) + 1;
    }
  }
  const byDept = Object.entries(deptCounts)
    .map(([department, c]) => ({ department, c }))
    .sort((a, b) => b.c - a.c);

  const recent = [...leads].reverse().slice(0, 50);

  return { total, pending, needHuman, byDept, recent };
}

// ===== Forwarded leads (real leads sent to managers) =====

// Was a lead for this patient+department already forwarded recently?
// Prevents paying twice for the same patient/same treatment/same dept.
export function wasRecentlyForwarded(whatsapp_number, department, hours = 24) {
  const key = normNum(whatsapp_number);
  const dept = (department || "").toLowerCase();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return db.data.forwarded.some(
    (f) =>
      normNum(f.whatsapp_number) === key &&
      (f.department || "").toLowerCase() === dept &&
      new Date(f.created_at).getTime() > cutoff
  );
}

// Record a lead that was actually forwarded to a manager.
export async function saveForwardedLead({ whatsapp_number, patient_name, department, summary }) {
  db.data.forwarded.push({
    whatsapp_number: normNum(whatsapp_number),
    patient_name: patient_name || "",
    department: (department || "").toLowerCase(),
    summary: (summary || "").slice(0, 300),
    created_at: nowISO(),
  });
  await db.write();
}

// All forwarded leads, newest first (for the portal Leads tab).
export function getForwardedLeads() {
  return [...db.data.forwarded].reverse();
}


// ===== V2: active-department state machine (per patient) =====
export function getActiveDept(whatsapp_number) {
  return db.data.deptState[normNum(whatsapp_number)] || "";
}
export async function setActiveDept(whatsapp_number, dept) {
  const key = normNum(whatsapp_number);
  const d = (dept || "").toLowerCase();
  if (d) db.data.deptState[key] = d; else delete db.data.deptState[key];
  await db.write();
}


// ===== V2.2: inactivity tracking (5-minute session reset) =====
export function minutesSinceLastActivity(whatsapp_number) {
  const ts = db.data.lastSeen[normNum(whatsapp_number)];
  if (!ts) return null; // never seen
  return (Date.now() - new Date(ts).getTime()) / 60000;
}
export async function touchActivity(whatsapp_number) {
  db.data.lastSeen[normNum(whatsapp_number)] = new Date().toISOString();
  await db.write();
}


// ===== V2.3: language preference + welcome variant counter =====
export function getLang(whatsapp_number) {
  return db.data.langState[normNum(whatsapp_number)] || "";
}
export async function setLang(whatsapp_number, lang) {
  db.data.langState[normNum(whatsapp_number)] = lang === "en" ? "en" : "ur";
  await db.write();
}
export async function clearLang(whatsapp_number) {
  delete db.data.langState[normNum(whatsapp_number)];
  await db.write();
}
export async function bumpMenuCount(whatsapp_number) {
  const k = normNum(whatsapp_number);
  db.data.menuCount[k] = (db.data.menuCount[k] || 0) + 1;
  await db.write();
  return db.data.menuCount[k];
}


// ===== V2.8: payment-await protection =====
// When Zainab has given bank details and asked for a payment screenshot, the
// patient leaves WhatsApp to do a bank transfer. That round trip routinely
// takes 10–40 minutes and sometimes resumes the next morning. While this
// flag is set, the session is protected from ANY idle reset — losing their
// collected details at that exact moment is the worst possible failure.
// Cleared automatically once the screenshot arrives (lead forwarded).
export function getAwaitingPayment(whatsapp_number) {
  const ts = db.data.awaitingPayment[normNum(whatsapp_number)];
  if (!ts) return null;
  const hours = (Date.now() - new Date(ts).getTime()) / 3600000;
  return { since: ts, hours };
}
export async function setAwaitingPayment(whatsapp_number, on = true) {
  const k = normNum(whatsapp_number);
  if (on) {
    if (!db.data.awaitingPayment[k]) { // keep the ORIGINAL request time
      db.data.awaitingPayment[k] = nowISO();
      await db.write();
    }
  } else if (db.data.awaitingPayment[k]) {
    delete db.data.awaitingPayment[k];
    await db.write();
  }
}


// ===== V2.7: tutorial video — sent ONCE ever per WhatsApp number =====
// Persists across session resets (unlike lang/dept/collected data) — the
// spec is explicit: "Never send the video again automatically", only a
// manual "how do I use this" question should trigger a resend (handled in
// server.js, which calls sendVideo() directly rather than this gate).
export function getVideoSent(whatsapp_number) {
  return !!db.data.videoSent[normNum(whatsapp_number)];
}
export async function setVideoSent(whatsapp_number) {
  db.data.videoSent[normNum(whatsapp_number)] = true;
  await db.write();
}


// ===== V2.6: pending ad context =====
// When a Meta-ad click arrives with a GENERIC auto-message ("How can I get
// more info?", "Hi"), we intercept with the language-select buttons — but we
// must not lose WHICH ad they clicked. The ad headline/body is parked here
// and injected into the brain on the patient's next real message.
export function getPendingAd(whatsapp_number) {
  return db.data.pendingAd[normNum(whatsapp_number)] || "";
}
export async function setPendingAd(whatsapp_number, ctx) {
  const k = normNum(whatsapp_number);
  if (ctx) db.data.pendingAd[k] = ctx; else delete db.data.pendingAd[k];
  await db.write();
}


// ===== V3: captured booking fields (fix: never re-ask name/number/etc.) =====
// Whatever the AI extracts (name, number, address, medical issue) is kept
// here for the ACTIVE workflow and injected back into every prompt, so the
// bot can never ask for the same thing twice — even if the chat history
// window has rolled past the original answer. Cleared on session reset and
// after a lead is forwarded (no permanent personal storage).
export function getCollected(whatsapp_number) {
  return db.data.collected[normNum(whatsapp_number)] || null;
}
export async function mergeCollected(whatsapp_number, fields) {
  const k = normNum(whatsapp_number);
  const cur = db.data.collected[k] || {};
  let changed = false;
  for (const f of ["patient_name", "contact_number", "address", "medical_issue", "visit_at"]) {
    const v = (fields?.[f] || "").toString().trim();
    // keep the first real value; ignore empties and placeholder dashes
    if (v && v !== "-" && v !== "..." && !cur[f]) { cur[f] = v; changed = true; }
  }
  if (changed) {
    cur.updated_at = nowISO();
    db.data.collected[k] = cur;
    await db.write();
  }
}
export async function clearCollected(whatsapp_number) {
  const k = normNum(whatsapp_number);
  if (db.data.collected[k]) { delete db.data.collected[k]; await db.write(); }
}


// ===== V3: weekly analysis helpers =====
// All messages from the last N days (for the weekly conversation analysis).
export function getMessagesSince(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.data.messages.filter((m) => new Date(m.created_at).getTime() > cutoff);
}
export function getForwardedSince(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.data.forwarded.filter((f) => new Date(f.created_at).getTime() > cutoff);
}
export function getLastWeeklyReport() {
  return db.data.lastWeeklyReport || "";
}
export async function setLastWeeklyReport(iso) {
  db.data.lastWeeklyReport = iso;
  await db.write();
}
