// =========================================================
//  corrections.js  — LIVE TRAINING via "zainab zainab"
//  Admin can correct Zainab by chat. Corrections are saved to
//  a "Corrections" tab in the Google Sheet, and Zainab reads
//  them with every reply — so fixes apply to ALL clients,
//  permanently, with no code changes.
// =========================================================

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const CORRECTIONS_TAB = "Corrections";

let cache = null;
let cacheTime = 0;
const CACHE_MINUTES = 5;

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getCorrectionsSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[CORRECTIONS_TAB];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: CORRECTIONS_TAB,
      headerValues: ["correction", "added_by", "added_at"],
    });
  }
  return sheet;
}

// Save a new correction (called when admin sends "zainab zainab ...").
export async function saveCorrection(text, addedBy) {
  try {
    const sheet = await getCorrectionsSheet();
    await sheet.addRow({
      correction: text,
      added_by: addedBy,
      added_at: new Date().toISOString(),
    });
    cache = null; // force refresh so it applies right away
    return true;
  } catch (e) {
    console.error("saveCorrection error:", e.message);
    return false;
  }
}

// Read all corrections as a text block for Zainab's prompt.
export async function loadCorrections() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_MINUTES * 60 * 1000) return cache;

  try {
    const sheet = await getCorrectionsSheet();
    const rows = await sheet.getRows();
    if (rows.length === 0) {
      cache = "";
      cacheTime = now;
      return "";
    }
    let text = "\n== انتظامیہ کی طرف سے اصلاحات (ہمیشہ ان پر عمل کریں) ==\n";
    for (const row of rows) {
      const c = row.get("correction");
      if (c) text += `- ${c}\n`;
    }
    cache = text;
    cacheTime = now;
    return text;
  } catch (e) {
    console.error("loadCorrections error:", e.message);
    return "";
  }
}
