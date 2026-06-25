// =========================================================
//  knowledge.js
//  Reads your Google Sheets (doctors, fees, timings, etc.)
//  so the AI can answer using YOUR hospital's real data.
// =========================================================

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

let cache = null;          // we remember the data so we don't re-read every message
let cacheTime = 0;
const CACHE_MINUTES = 30;   // refresh from Sheets every 30 minutes (faster responses)

// Tabs that are NOT hospital knowledge — skip them so the AI prompt
// stays small and fast (these are data/operational tabs).
const SKIP_TABS = ["Patients", "Corrections", "Managers"];

// Connect to Google using the "service account" (a robot Google login)
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

// Read every sheet (tab) and turn it into plain text the AI can read.
export async function loadKnowledge() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_MINUTES * 60 * 1000) {
    return cache; // use remembered copy
  }

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();

  let text = "";
  for (const sheet of doc.sheetsByIndex) {
    if (SKIP_TABS.includes(sheet.title)) continue; // skip data/operational tabs
    text += `\n### ${sheet.title}\n`;
    const rows = await sheet.getRows();
    if (rows.length === 0) {
      text += "(no data yet)\n";
      continue;
    }
    const headers = sheet.headerValues;
    for (const row of rows) {
      const parts = headers.map((h) => `${h}: ${row.get(h) ?? ""}`);
      text += "- " + parts.join(" | ") + "\n";
    }
  }

  cache = text;
  cacheTime = now;
  return text;
}

// Let the app refresh knowledge immediately after a correction is saved.
export function clearKnowledgeCache() {
  cache = null;
}
