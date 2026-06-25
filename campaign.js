// =========================================================
//  campaign.js  — send a marketing template to EXISTING
//  (opted-in) patients only. No external list uploads.
//  Uses an approved MARKETING template from Meta.
// =========================================================

import axios from "axios";
import { getAllPatients } from "./patients.js";

const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WABA_ID = process.env.WA_BUSINESS_ACCOUNT_ID;

// Fetch the list of APPROVED templates from Meta (for the dropdown).
export async function getApprovedTemplates() {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v21.0/${WABA_ID}/message_templates`,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        params: { limit: 100, fields: "name,status,category,language" },
      }
    );
    const all = resp.data?.data || [];
    return all
      .filter((t) => t.status === "APPROVED")
      .map((t) => ({ name: t.name, category: t.category, language: t.language }));
  } catch (e) {
    console.error("getApprovedTemplates error:", e.response?.data?.error?.message || e.message);
    return [];
  }
}

// Send one marketing template to one number.
async function sendCampaignMessage(to, templateName, templateLang, param) {
  const components = param
    ? [{ type: "body", parameters: [{ type: "text", text: param }] }]
    : [];
  await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLang },
        components,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// Send a campaign to ALL existing patients. Returns counts.
// param is an optional text that fills {{1}} in the template
// (e.g. the camp/offer details).
export async function runCampaign(templateName, templateLang, param) {
  const patients = await getAllPatients();
  let sent = 0;
  let failed = 0;
  for (const p of patients) {
    try {
      await sendCampaignMessage(p.number, templateName, templateLang, param);
      sent++;
      // small delay to be gentle on the API
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      failed++;
      console.error(`Campaign send failed for ${p.number}:`, e.response?.data?.error?.message || e.message);
    }
  }
  return { total: patients.length, sent, failed };
}
