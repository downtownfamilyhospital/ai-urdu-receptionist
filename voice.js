// =========================================================
//  voice.js  — PHASE 2A (voice IN)
//  Handles patient VOICE NOTES:
//   1. Downloads the audio file from WhatsApp (Meta)
//   2. Sends it to OpenAI Whisper to convert speech → text
//   3. Returns the Urdu/Roman-Urdu text so the brain can read it
// =========================================================

import axios from "axios";
import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 2 });
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

// Step 1: WhatsApp gives us a media "id". We ask Meta for the real
// download URL, then download the actual audio bytes.
async function downloadWhatsAppAudio(mediaId) {
  // 1a. Get the temporary download URL for this media id
  const meta = await axios.get(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  const mediaUrl = meta.data.url;

  // 1b. Download the audio bytes (must send the token again)
  const audio = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    responseType: "arraybuffer",
  });

  return Buffer.from(audio.data);
}

// Speech-to-text models to try, in order. The OpenAI project may have a
// model ALLOW-LIST (Limits → Model usage) — if one model is blocked
// (403 / model_not_found), we automatically try the next one and remember
// which one worked so future voice notes transcribe on the first try.
// Override order with OPENAI_TRANSCRIBE_MODEL if needed.
const TRANSCRIBE_MODELS = [
  process.env.OPENAI_TRANSCRIBE_MODEL,
  "whisper-1",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
].filter(Boolean);

let workingModel = null; // remembered after the first success

// Step 2+3: Turn a patient's voice note (media id) into text.
export async function transcribeVoice(mediaId) {
  // Download the audio from WhatsApp
  const audioBuffer = await downloadWhatsAppAudio(mediaId);

  // WhatsApp voice notes are .ogg (opus) files
  const file = await toFile(audioBuffer, "voice.ogg");

  const candidates = workingModel
    ? [workingModel, ...TRANSCRIBE_MODELS.filter((m) => m !== workingModel)]
    : TRANSCRIBE_MODELS;

  let lastErr;
  for (const model of candidates) {
    try {
      // We hint Urdu; these models also handle Roman Urdu / mixed speech well.
      const result = await openai.audio.transcriptions.create({
        file,
        model,
        language: "ur",
      });
      if (model !== workingModel) {
        workingModel = model;
        console.log(`🎙️ Voice transcription using model: ${model}`);
      }
      return result.text || "";
    } catch (e) {
      lastErr = e;
      const msg = e?.error?.message || e?.message || "";
      const blocked =
        e?.status === 403 || e?.status === 404 ||
        /model_not_found|does not have access|invalid model|not supported/i.test(msg);
      if (blocked) {
        console.warn(`🎙️ Transcription model "${model}" not available (${msg.slice(0, 100)}) — trying next`);
        continue; // try the next model in the chain
      }
      throw e; // network/audio error — no point trying other models
    }
  }
  console.error(
    "❌ ALL transcription models blocked for this OpenAI project. " +
    "Fix: platform.openai.com → Settings → your project → Limits → Model usage → allow 'whisper-1' (or gpt-4o-mini-transcribe)."
  );
  throw lastErr;
}
