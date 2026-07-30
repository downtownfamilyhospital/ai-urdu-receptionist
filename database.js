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

function nowISO() {
  return new Date().toISOString();
}

// CRITICAL: normalize every WhatsApp number to ONE canonical format
// (923xxxxxxxxx — digits only, 0→92) so the same patient is never split
// across formats and DIFFERENT patients are never mixed. Used on every
// store and every lookup.
function normNum(num) {
  let n = (num || "").replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "92" + n.slice(1);
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
export function getRecentHistory(whatsapp_number, limit = 6) {
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
export async function bumpMenuCount(whatsapp_number) {
  const k = normNum(whatsapp_number);
  db.data.menuCount[k] = (db.data.menuCount[k] || 0) + 1;
  await db.write();
  return db.data.menuCount[k];
}
