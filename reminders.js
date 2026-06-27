// =========================================================
//  reminders.js  — appointment reminders 3 hours before.
//  Stores appointments in a "Reminders" tab. A scheduler
//  (in server.js) checks every 15 min and sends a reminder
//  template ~3h before the visit, then marks it sent.
//  Requires an approved template (default: appointment_reminder).
// =========================================================

import axios from "axios";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const TAB = "Reminders";
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const REMINDER_TEMPLATE = process.env.REMINDER_TEMPLATE_NAME || "appointment_reminder";
const REMINDER_LANG = process.env.REMINDER_TEMPLATE_LANG || "en";

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheet() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[TAB];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: TAB,
      headerValues: ["whatsapp_number", "name", "details", "visit_at_iso", "sent", "created_at"],
    });
  }
  return sheet;
}

// Save an appointment for reminding. visit_at_iso must be an ISO datetime
// string (when the patient is due to visit). If we can't parse a time,
// nothing is scheduled (no reminder).
export async function scheduleReminder(whatsappNumber, name, details, visitAtIso) {
  try {
    if (!visitAtIso) return;
    const when = new Date(visitAtIso);
    if (isNaN(when.getTime())) return; // unparseable → skip
    const sheet = await getSheet();
    await sheet.addRow({
      whatsapp_number: whatsappNumber,
      name: name || "",
      details: (details || "").replace(/[\r\n\t]+/g, " ").slice(0, 300),
      visit_at_iso: when.toISOString(),
      sent: "no",
      created_at: new Date().toISOString(),
    });
    console.log(`⏰ Reminder scheduled for ${whatsappNumber} at ${when.toISOString()}`);
  } catch (e) {
    console.error("scheduleReminder error:", e.message);
  }
}

// Called periodically: send reminders for visits ~3h away, not yet sent.
export async function processReminders() {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const now = Date.now();
    for (const row of rows) {
      if ((row.get("sent") || "no") === "yes") continue;
      const visit = new Date(row.get("visit_at_iso") || 0).getTime();
      if (isNaN(visit)) continue;
      const hoursUntil = (visit - now) / (1000 * 60 * 60);
      // send when between ~3h and ~2.75h before (so it fires once)
      if (hoursUntil <= 3 && hoursUntil > 2.75) {
        const to = (row.get("whatsapp_number") || "").replace(/[^0-9]/g, "");
        const name = row.get("name") || "";
        const details = row.get("details") || "";
        await sendReminder(to, name, details);
        row.set("sent", "yes");
        await row.save();
      }
      // cleanup: mark very old (past) ones as sent so they don't linger
      if (hoursUntil < -2) { row.set("sent", "yes"); await row.save(); }
    }
  } catch (e) {
    console.error("processReminders error:", e.message);
  }
}

async function sendReminder(to, name, details) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: REMINDER_TEMPLATE,
          language: { code: REMINDER_LANG },
          components: [
            { type: "body", parameters: [
              { type: "text", text: name || "" },
              { type: "text", text: details || "your appointment" },
            ] },
          ],
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`⏰ Reminder sent to ${to}`);
  } catch (e) {
    console.error("sendReminder error:", e.response?.data?.error?.message || e.message);
  }
}
