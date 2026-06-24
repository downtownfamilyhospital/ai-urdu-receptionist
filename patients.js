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
      headerValues: ["whatsapp_number", "name", "address", "pin_location", "last_service", "last_seen"],
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

    // Patient data is kept permanently (for future correspondence & campaigns).
    // We still greet returning patients by name regardless of how long ago.
    const name = row.get("name") || "";
    const address = row.get("address") || "";
    const pinLocation = row.get("pin_location") || "";
    const lastService = row.get("last_service") || "";

    let note = "(RETURNING PATIENT — hum is mareez ko pehle se jante hain. ";
    if (name) note += `Name: ${name}. `;
    if (address) note += `Address: ${address}. `;
    if (pinLocation) note += `Pin location: saved. `;
    if (lastService) note += `Last service: ${lastService}. `;
    note +=
      "IMPORTANT: Pehle se mojood naam le kar garam joshi se salam karein aur surprise dein ke hum unhe yaad rakhte hain " +
      "(e.g. 'السلام علیکم [Name] جی! 🌸 آپ کیسے ہیں؟ ہم دوبارہ آپ کی کیا خدمت کریں؟'). " +
      "Naam, number, address dobara MAT poochein. Agar woh naya order dein, to seedha order note karein aur " +
      "unke pehle se mojood record (naam, number, address) ke sath summary bana kar bhej dein — " +
      "is repeat customer se 'kya ye sahi hai?' bhi poochne ki zaroorat nahi, bas confirm kar ke aage barhein. " +
      "Sirf agar woh khud naya address/number batayein to use update kar lein.)";
    return note;
  } catch (e) {
    console.error("getPatientMemory error:", e.message);
    return ""; // fail safe: behave as if new patient
  }
}

// Save / update a patient's profile after a conversation.
export async function savePatientMemory(whatsappNumber, { name, address, pin_location, last_service }) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const existing = rows.find((r) => r.get("whatsapp_number") === whatsappNumber);
    const now = new Date().toISOString();

    if (existing) {
      // Overwrite a field only when we have NEW info for it (keeps old otherwise).
      // So a new address/pin from the patient automatically replaces the old one.
      if (name) existing.set("name", name);
      if (address) existing.set("address", address);
      if (pin_location) existing.set("pin_location", pin_location);
      if (last_service) existing.set("last_service", last_service);
      existing.set("last_seen", now);
      await existing.save();
    } else {
      await sheet.addRow({
        whatsapp_number: whatsappNumber,
        name: name || "",
        address: address || "",
        pin_location: pin_location || "",
        last_service: last_service || "",
        last_seen: now,
      });
    }
  } catch (e) {
    console.error("savePatientMemory error:", e.message);
  }
}
