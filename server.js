// =========================================================
//  voice.js  — PHASE 2A (voice IN)
//  Handles patient VOICE NOTES:
//   1. Downloads the audio file from WhatsApp (Meta)
//   2. Sends it to OpenAI Whisper to convert speech → text
//   3. Returns the Urdu/Roman-Urdu text so the brain can read it
// =========================================================

import axios from "axios";
import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

// Step 2+3: Turn a patient's voice note (media id) into text.
export async function transcribeVoice(mediaId) {
  // Download the audio from WhatsApp
  const audioBuffer = await downloadWhatsAppAudio(mediaId);

  // WhatsApp voice notes are .ogg (opus) files
  const file = await toFile(audioBuffer, "voice.ogg");

  // Send to Whisper. We hint Urdu, but Whisper also handles
  // Roman Urdu / mixed speech well.
  const result = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "ur", // Urdu hint; remove if you want pure auto-detect
  });

  return result.text || "";
}
