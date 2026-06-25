// =========================================================
//  database.js
//  Stores leads (every patient inquiry) and short
//  conversation history. Uses a simple JSON file (lowdb) —
//  no compiling needed, installs instantly, works on Railway.
// =========================================================

import { JSONFilePreset } from "lowdb/node";

// Create / open the data file with starting structure.
const db = await JSONFilePreset("hospital.json", { leads: [], messages: [] });

function nowISO() {
  return new Date().toISOString();
}

export async function saveLead({ patient_name, whatsapp_number, inquiry, department, intent, needs_human }) {
  db.data.leads.push({
    id: db.data.leads.length + 1,
    patient_name: patient_name || "",
    whatsapp_number,
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
    whatsapp_number,
    role,
    content,
    created_at: nowISO(),
  });
  await db.write();
}

// Get the last few messages so the AI remembers the conversation.
export function getRecentHistory(whatsapp_number, limit = 6) {
  const all = db.data.messages.filter((m) => m.whatsapp_number === whatsapp_number);
  return all.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}

// Simple stats for the dashboard.
// Get a list of all patients who have messaged, with their last message + time.
export function getConversations() {
  const byNumber = {};
  for (const m of db.data.messages) {
    if (!byNumber[m.whatsapp_number]) {
      byNumber[m.whatsapp_number] = { whatsapp_number: m.whatsapp_number, last: m.content, time: m.created_at, count: 0 };
    }
    byNumber[m.whatsapp_number].last = m.content;
    byNumber[m.whatsapp_number].time = m.created_at;
    byNumber[m.whatsapp_number].count++;
  }
  return Object.values(byNumber).sort((a, b) => (a.time < b.time ? 1 : -1));
}

// Get the full conversation for one patient number.
export function getConversation(whatsapp_number) {
  return db.data.messages
    .filter((m) => m.whatsapp_number === whatsapp_number)
    .map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
}

// Get stats for one patient number (most recent lead info).
export function getPatientLead(whatsapp_number) {
  const leads = db.data.leads.filter((l) => l.whatsapp_number === whatsapp_number);
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
