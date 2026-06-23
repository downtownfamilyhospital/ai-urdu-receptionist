// =========================================================
//  database.js
//  Stores leads (every patient inquiry) in a small local
//  database file (SQLite). No external database needed.
//  Also keeps short conversation history per patient.
// =========================================================

import Database from "better-sqlite3";

const db = new Database("hospital.db");

// Create the tables the first time the app runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT,
    whatsapp_number TEXT,
    inquiry TEXT,
    department TEXT,
    intent TEXT,
    needs_human INTEGER DEFAULT 0,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp_number TEXT,
    role TEXT,          -- 'user' or 'assistant'
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

export function saveLead({ patient_name, whatsapp_number, inquiry, department, intent, needs_human }) {
  db.prepare(`
    INSERT INTO leads (patient_name, whatsapp_number, inquiry, department, intent, needs_human)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(patient_name || "", whatsapp_number, inquiry, department || "", intent || "general", needs_human ? 1 : 0);
}

export function saveMessage(whatsapp_number, role, content) {
  db.prepare(`INSERT INTO messages (whatsapp_number, role, content) VALUES (?, ?, ?)`)
    .run(whatsapp_number, role, content);
}

// Get the last few messages so the AI remembers the conversation.
export function getRecentHistory(whatsapp_number, limit = 6) {
  const rows = db.prepare(`
    SELECT role, content FROM messages
    WHERE whatsapp_number = ?
    ORDER BY id DESC LIMIT ?
  `).all(whatsapp_number, limit);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

// Simple stats for the dashboard.
export function getStats() {
  const total = db.prepare(`SELECT COUNT(*) c FROM leads`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) c FROM leads WHERE status='new'`).get().c;
  const needHuman = db.prepare(`SELECT COUNT(*) c FROM leads WHERE needs_human=1`).get().c;
  const byDept = db.prepare(`
    SELECT department, COUNT(*) c FROM leads
    WHERE department != '' GROUP BY department ORDER BY c DESC
  `).all();
  const recent = db.prepare(`
    SELECT patient_name, whatsapp_number, inquiry, department, intent, needs_human, created_at
    FROM leads ORDER BY id DESC LIMIT 50
  `).all();
  return { total, pending, needHuman, byDept, recent };
}
