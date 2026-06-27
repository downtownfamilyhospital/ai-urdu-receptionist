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

// Normalize any number to a single canonical form (digits only, no +,
// no leading zeros) so the SAME person always matches ONE row,
// regardless of whether it was saved as +923..., 923..., or 03...
function normalizeNumber(num) {
  let n = (num || "").replace(/[^0-9]/g, ""); // digits only
  if (n.startsWith("0")) n = "92" + n.slice(1); // 03xx... → 923xx...
  return n;
}

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
      headerValues: ["whatsapp_number", "name", "address", "pin_location", "last_service", "image_link", "last_seen"],
    });
  }
  return sheet;
}

// Look up a patient by number. Returns their remembered profile
// as a short text note for Zainab, or "" if new / expired.
export async function getPatientMemory(whatsappNumber, isFresh = true) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === normalizeNumber(whatsappNumber));
    if (!row) return "";

    // Patient data is kept permanently (for future correspondence & campaigns).
    // We still greet returning patients by name regardless of how long ago.
    const name = row.get("name") || "";
    const address = row.get("address") || "";
    const pinLocation = row.get("pin_location") || "";
    const lastService = row.get("last_service") || "";

    let note = "(ہم اس مریض کو پہلے سے جانتے ہیں — یہ معلومات یاد رکھیں، دوبارہ نہ پوچھیں: ";
    if (name) note += `نام: ${name}۔ `;
    if (address) note += `پتہ: ${address}۔ `;
    if (pinLocation) note += `پن لوکیشن: محفوظ ہے۔ `;
    if (lastService) note += `پچھلی سروس: ${lastService}۔ `;
    note += `واٹس ایپ نمبر: ${whatsappNumber}۔ `;
    if (isFresh) {
      note +=
        "چونکہ یہ نئی گفتگو کا آغاز ہے، نام لے کر گرم جوشی سے سلام کریں " +
        "(مثلاً 'السلام علیکم [نام] جی! 🌸 آپ کیسے ہیں؟ بتائیں آج کیا خدمت کروں؟')۔ ";
    } else {
      note += "گفتگو جاری ہے — دوبارہ سلام/welcome back نہ کہیں۔ ";
    }
    note +=
      "نام، نمبر، پتہ دوبارہ کبھی نہ پوچھیں — یہ پہلے سے معلوم ہیں۔ " +
      "لیڈ مکمل کرنے سے پہلے خلاصے میں یہ نام، واٹس ایپ نمبر اور پتہ دکھا کر مریض سے تصدیق ضرور لیں۔ " +
      "اگر مریض خود نیا پتہ/نمبر بتائے تو اپڈیٹ کر لیں۔)";
    return note;
  } catch (e) {
    console.error("getPatientMemory error:", e.message);
    return ""; // fail safe: behave as if new patient
  }
}

// Save / update a patient's profile after a conversation.
export async function savePatientMemory(whatsappNumber, { name, address, pin_location, last_service, image_link } = {}) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const existing = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === normalizeNumber(whatsappNumber));
    const now = new Date().toISOString();

    if (existing) {
      if (name) existing.set("name", name);
      if (address) existing.set("address", address);
      if (pin_location) existing.set("pin_location", pin_location);
      if (last_service) existing.set("last_service", last_service);
      if (image_link) existing.set("image_link", image_link);
      existing.set("last_seen", now);
      await existing.save();
    } else {
      await sheet.addRow({
        whatsapp_number: "+" + normalizeNumber(whatsappNumber),
        name: name || "",
        address: address || "",
        pin_location: pin_location || "",
        last_service: last_service || "",
        image_link: image_link || "",
        last_seen: now,
      });
    }
  } catch (e) {
    console.error("savePatientMemory error:", e.message);
  }
}

// Get ALL patients (for campaigns to opted-in patients only).
// Get the most recent photo link saved for this patient (and clear it
// so it isn't attached to a future unrelated lead).
export async function getAndClearPatientImage(whatsappNumber) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === normalizeNumber(whatsappNumber));
    if (!row) return "";
    const link = row.get("image_link") || "";
    if (link) {
      row.set("image_link", "");
      await row.save();
    }
    return link;
  } catch (e) {
    console.error("getAndClearPatientImage error:", e.message);
    return "";
  }
}

export async function getAllPatients() {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const norm = normalizeNumber(r.get("whatsapp_number"));
      if (!norm || seen.has(norm)) continue; // skip blanks and duplicates
      seen.add(norm);
      out.push({ number: norm, name: r.get("name") || "" });
    }
    return out;
  } catch (e) {
    console.error("getAllPatients error:", e.message);
    return [];
  }
}

// Get the latest hosted image link for a patient (for manager leads).
export async function getPatientImageLink(whatsappNumber) {
  try {
    const sheet = await getPatientsSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => normalizeNumber(r.get("whatsapp_number")) === normalizeNumber(whatsappNumber));
    return row ? (row.get("image_link") || "") : "";
  } catch (e) {
    console.error("getPatientImageLink error:", e.message);
    return "";
  }
}
