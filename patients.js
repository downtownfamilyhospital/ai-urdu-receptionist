// =========================================================
//  patients.js  — PATIENT MEMORY (stored in Google Sheet)
//  Remembers each patient (by WhatsApp number): name, address,
//  last service, and when last seen. So Zainab can RECONFIRM
//  instead of re-asking. Kept for ~7 days.
// =========================================================

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const REMEMBER_DAYS = 7;
const PATIENTS_TAB = "Patients";

// Read+write auth (note: full spreadsheets scope, not readonly)
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getPatientsSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[PATIENTS_TAB];
  // If the Patients tab doesn't exist yet, create it with headers.
  if (!sheet) {
    sheet = await doc.addSheet({
      title: PATIENTS_TAB,
      headerValues: ["whatsapp_number", "name", "address", "last_service", "last_seen"],
    });
  }
  return sheet;
}

// Look up a patient by number. Returns their remembered profile
// as a short text note for Zainab, or "" if new / expired.
export async function getPatientMemory(whatsappNumber) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => r.get("whatsapp_number") === whatsappNumber);
    if (!row) return "";

    const lastSeen = new Date(row.get("last_seen") || 0);
    const ageDays = (Date.now() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > REMEMBER_DAYS) return ""; // too old, treat as new

    const name = row.get("name") || "";
    const address = row.get("address") || "";
    const lastService = row.get("last_service") || "";

    let note = "(RETURNING PATIENT — we already know them. ";
    if (name) note += `Name: ${name}. `;
    if (address) note += `Address: ${address}. `;
    if (lastService) note += `Last service: ${lastService}. `;
    note +=
      "Do NOT ask their name again — greet them by name warmly. " +
      "For number/address, RECONFIRM gently instead of asking fresh, e.g. " +
      "'kya isi number aur pichlay address par bhej dein?')";
    return note;
  } catch (e) {
    console.error("getPatientMemory error:", e.message);
    return ""; // fail safe: behave as if new patient
  }
}

// Save / update a patient's profile after a conversation.
export async function savePatientMemory(whatsappNumber, { name, address, last_service }) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const existing = rows.find((r) => r.get("whatsapp_number") === whatsappNumber);
    const now = new Date().toISOString();

    if (existing) {
      // Only overwrite fields we actually have new info for (keep old otherwise)
      if (name) existing.set("name", name);
      if (address) existing.set("address", address);
      if (last_service) existing.set("last_service", last_service);
      existing.set("last_seen", now);
      await existing.save();
    } else {
      await sheet.addRow({
        whatsapp_number: whatsappNumber,
        name: name || "",
        address: address || "",
        last_service: last_service || "",
        last_seen: now,
      });
    }
  } catch (e) {
    console.error("savePatientMemory error:", e.message);
  }
}
