// =========================================================
//  conversations.js  — DURABLE conversation memory that
//  survives restarts, but stays SMALL and FAST.
//  • One row per ACTIVE patient (not one row per message)
//  • Stores last ~15 messages as compact JSON
//  • Auto-clears after 12h inactivity OR when lead completes
//  So Zainab resumes interrupted bookings without the Sheet
//  ever becoming bulky.
// =========================================================

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const TAB = "Conversations";
const MAX_MESSAGES = 15;          // keep only the last N messages per patient
const EXPIRY_HOURS = 12;          // forget after this many hours of inactivity

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function normalizeNumber(num) {
  let n = (num || "").replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "92" + n.slice(1);
  return n;
}

async function getSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[TAB];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: TAB,
      headerValues: ["whatsapp_number", "messages_json", "updated_at"],
    });
  }
  return sheet;
}

// Load a patient's recent conversation (if within 12h). Returns an
// array of {role, content} for the AI, or [] if none/expired.
export async function loadConversation(whatsappNumber) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const num = normalizeNumber(whatsappNumber);
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === num);
    if (!row) return [];

    const updated = new Date(row.get("updated_at") || 0);
    const ageHours = (Date.now() - updated.getTime()) / (1000 * 60 * 60);
    if (ageHours > EXPIRY_HOURS) {
      // expired — delete the stale row so the sheet stays lean
      await row.delete();
      return [];
    }
    try {
      return JSON.parse(row.get("messages_json") || "[]");
    } catch {
      return [];
    }
  } catch (e) {
    console.error("loadConversation error:", e.message);
    return [];
  }
}

// Append the latest exchange and save (trimmed to last MAX_MESSAGES).
export async function saveConversation(whatsappNumber, history, userMsg, aiMsg) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const num = normalizeNumber(whatsappNumber);
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === num);

    let messages = Array.isArray(history) ? history.slice() : [];
    if (userMsg) messages.push({ role: "user", content: userMsg });
    if (aiMsg) messages.push({ role: "assistant", content: aiMsg });
    // keep only the most recent MAX_MESSAGES
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

    const json = JSON.stringify(messages);
    const now = new Date().toISOString();

    if (row) {
      row.set("messages_json", json);
      row.set("updated_at", now);
      await row.save();
    } else {
      await sheet.addRow({
        whatsapp_number: "+" + num,
        messages_json: json,
        updated_at: now,
      });
    }
  } catch (e) {
    console.error("saveConversation error:", e.message);
  }
}

// Clear a patient's conversation (called when a lead completes/forwards).
export async function clearConversation(whatsappNumber) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const num = normalizeNumber(whatsappNumber);
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === num);
    if (row) await row.delete();
  } catch (e) {
    console.error("clearConversation error:", e.message);
  }
}

// Housekeeping: remove all expired rows (called occasionally).
export async function cleanupExpired() {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    for (const row of rows) {
      const updated = new Date(row.get("updated_at") || 0);
      const ageHours = (Date.now() - updated.getTime()) / (1000 * 60 * 60);
      if (ageHours > EXPIRY_HOURS) await row.delete();
    }
  } catch (e) {
    console.error("cleanupExpired error:", e.message);
  }
}
