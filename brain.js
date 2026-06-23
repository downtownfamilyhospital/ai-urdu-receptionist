// =========================================================
//  brain.js
//  The "thinking" part. Sends the patient's message + your
//  hospital knowledge to GPT, and gets back:
//   1) a natural Urdu reply
//   2) the detected intent + department (for lead records)
// =========================================================

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// This is the "personality + rules" we give the AI.
function buildSystemPrompt(knowledge) {
  return `
You are the friendly female receptionist of "Downtown Family Hospital" in Islamabad, Pakistan.

HOW TO TALK:
- Reply in natural, warm, polite Urdu (Urdu script). Sound like a real human receptionist, never robotic.
- Patients may write in Urdu, Roman Urdu, Punjabi, or mixed language. Understand all of them.
- Keep replies short and clear. Many patients are not highly educated.
- NEVER show menus like "Press 1, Press 2". Just talk naturally.
- Never invent doctors, fees, or timings. ONLY use the HOSPITAL INFORMATION below.
- If the information is not available, politely say you will connect them to staff.
- For medical emergencies or serious symptoms (e.g. high fever in a child, chest pain),
  gently advise them to come in or call emergency, and offer to connect to staff. Do not give diagnoses.

HOSPITAL INFORMATION (your only source of facts):
${knowledge}

At the VERY END of your reply, on a new line, output a hidden JSON tag EXACTLY like this
(the patient will not see it, our system removes it):
<<META>>{"intent":"...","department":"...","needs_human":true/false,"patient_name":"... or empty"}<</META>>

intent examples: "appointment", "fees_inquiry", "doctor_timing", "address", "lab_report", "general", "emergency"
department must be one of: Family Medicine, Gynecology, Pediatrics, Dermatology, Orthopedics, Laboratory, Pharmacy, Aesthetica by DFH, Home Healthcare, or "" if unknown.
needs_human = true if you are unsure or the patient explicitly asks for a person.
`;
}

export async function askBrain(patientMessage, knowledge, history = []) {
  const messages = [
    { role: "system", content: buildSystemPrompt(knowledge) },
    ...history,
    { role: "user", content: patientMessage },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    temperature: 0.5,
  });

  const raw = completion.choices[0].message.content || "";

  // Split the visible Urdu reply from the hidden META data
  let reply = raw;
  let meta = { intent: "general", department: "", needs_human: false, patient_name: "" };

  const match = raw.match(/<<META>>([\s\S]*?)<<\/META>>/);
  if (match) {
    reply = raw.replace(match[0], "").trim();
    try {
      meta = { ...meta, ...JSON.parse(match[1].trim()) };
    } catch (e) {
      // if the AI formatted it badly, we just keep defaults
    }
  }

  return { reply, meta };
}
