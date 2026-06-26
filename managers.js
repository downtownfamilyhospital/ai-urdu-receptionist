// =========================================================
//  managers.js  — forward completed leads to dept managers
//  Manager numbers live in a "Managers" tab in the Sheet:
//    department | manager_name | whatsapp_number
//  e.g.  pharmacy | Ali | 923001234567
//  Leads are sent via an approved WhatsApp TEMPLATE so they
//  always deliver (no 24-hour window limit).
// =========================================================

import axios from "axios";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const MANAGERS_TAB = "Managers";
const TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || "new_lead";
const TEMPLATE_LANG = process.env.LEAD_TEMPLATE_LANG || "en";

const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

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

async function getManagersSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[MANAGERS_TAB];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: MANAGERS_TAB,
      headerValues: ["department", "manager_name", "whatsapp_number"],
    });
  }
  return sheet;
}

// Load department → manager numbers (cached 5 min).
async function loadManagers() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_MINUTES * 60 * 1000) return cache;
  const sheet = await getManagersSheet();
  const rows = await sheet.getRows();
  const map = {};
  for (const r of rows) {
    const dept = (r.get("department") || "").trim().toLowerCase();
    const num = (r.get("whatsapp_number") || "").replace(/[^0-9]/g, ""); // digits only
    if (dept && num) {
      if (!map[dept]) map[dept] = [];
      map[dept].push(num);
    }
  }
  cache = map;
  cacheTime = now;
  return map;
}

// Send a lead summary to the right department manager(s) via template.
export async function forwardLeadToManager(department, summary, patientNumber) {
  try {
    const managers = await loadManagers();
    const dept = (department || "").trim().toLowerCase();
    const numbers = managers[dept] || [];
    if (numbers.length === 0) {
      console.log(`⚠️ No manager number found for department "${dept}"`);
      return;
    }

    // WhatsApp template parameters can't contain newlines, tabs, or 4+
    // spaces. Flatten the summary into a single clean line for the template.
    const cleanParam = (s) =>
      (s || "")
        .replace(/[\r\n\t]+/g, " | ")  // newlines/tabs → separator
        .replace(/\s{2,}/g, " ")        // collapse multiple spaces
        .trim();
    const deptParam = cleanParam(dept);
    const summaryParam = cleanParam(summary).slice(0, 1000);
    const numberParam = cleanParam(patientNumber);

    for (const to of numbers) {
      try {
        await axios.post(
          `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: TEMPLATE_NAME,
              language: { code: TEMPLATE_LANG },
              components: [
                {
                  type: "body",
                  parameters: [
                    { type: "text", text: deptParam },
                    { type: "text", text: summaryParam },
                    { type: "text", text: numberParam },
                  ],
                },
              ],
            },
          },
          {
            headers: {
              Authorization: `Bearer ${ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log(`📤 Lead forwarded to ${dept} manager (${to}) via template`);
      } catch (tplErr) {
        // Template failed (e.g. not approved in this account / wrong lang).
        // Log the FULL reason, then try a plain-text message as a fallback
        // (works if the manager messaged the bot within the last 24h).
        console.error(
          `⚠️ Template send failed for ${dept} (${to}):`,
          JSON.stringify(tplErr.response?.data?.error || tplErr.message)
        );
        try {
          const textBody =
            `🔔 New ${dept} lead\n\n${summary}\n\nPatient WhatsApp: ${patientNumber}\n\nPlease follow up.`;
          await axios.post(
            `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to, type: "text", text: { body: textBody } },
            { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
          );
          console.log(`📤 Lead forwarded to ${dept} manager (${to}) via plain text (fallback)`);
        } catch (txtErr) {
          console.error(
            `❌ Both template AND text failed for ${dept} (${to}):`,
            JSON.stringify(txtErr.response?.data?.error || txtErr.message)
          );
        }
      }
    }
  } catch (e) {
    console.error("forwardLeadToManager error:", e.response?.data || e.message);
  }
}
