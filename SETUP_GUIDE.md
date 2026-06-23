# AI Urdu Hospital Receptionist — Phase 1 Setup Guide
### Written in simple language for a hospital owner (no coding needed to follow along)

This guide gets your **text** receptionist working. Voice comes in Phase 2.

Think of it like opening a new reception desk. You need:
1. A "desk" (the server, on Railway)
2. A "phone line" (WhatsApp via 360dialog)
3. A "brain" (OpenAI)
4. A "rulebook/file cabinet" (Google Sheets with your hospital info)

You will hand this folder to one developer. The steps below are what THEY do; you provide
the accounts and the hospital information. I've explained the "why" so you can supervise.

---

## STEP 1 — Create the accounts (you, the owner, do this)

| Account | Where | Why |
|--------|-------|-----|
| OpenAI | platform.openai.com | The AI brain. Add ~$20 credit to start. |
| 360dialog | hub.360dialog.com | Your WhatsApp Business number. |
| Google Cloud | console.cloud.google.com | To let the app read your Google Sheet. |
| Railway | railway.app | Where the app "lives" online. |
| GitHub | github.com | To store the code (free). |

---

## STEP 2 — Build your knowledge base (Google Sheets)

1. Create one new Google Sheet. Name it "DFH Knowledge Base".
2. At the bottom, create these tabs (sheets). Use the EXACT column names shown.

**Tab: Doctors**
| Doctor Name | Department | Days Available | Timings | Consultation Fee |
| Dr. Ayesha Khan | Gynecology | Mon, Wed, Fri | 5pm–8pm | Rs. 2000 |

**Tab: Services**
| Service Name | Department | Price | Description |
| PRP Treatment | Aesthetica by DFH | Rs. 15000 | Skin rejuvenation therapy |

**Tab: Fees**
| Item | Price |
| General Consultation | Rs. 1500 |

**Tab: Timings**
| Department | Opening | Closing |
| Laboratory | 8am | 10pm |

**Tab: Hospital Information**
| Key | Value |
| Address | Main Blue Area, Islamabad |
| Google Maps | https://maps.google.com/... |
| Emergency Timings | 24/7 |
| Phone | 051-xxxxxxx |

**Tab: Lab Tests**
| Test Name | Price | Report Time |
| CBC | Rs. 800 | Same day |

**Tab: Aesthetic Services** and **Tab: Home Services** — same idea: name, price, description.

> 👉 The beauty of this: to change a fee or doctor timing later, you just edit the Sheet.
> No coding. The AI reads the latest version automatically (within 5 minutes).

---

## STEP 3 — Give the app permission to read the Sheet

Your developer does this in Google Cloud:
1. Create a "Service Account" → download its JSON key file.
2. Open that JSON file, copy ALL of it.
3. In your Google Sheet, click **Share** and share it (Viewer) with the
   `client_email` address found inside that JSON (looks like `...@...iam.gserviceaccount.com`).
4. Copy your Sheet's ID — it's the long code in the Sheet's web address between `/d/` and `/edit`.

---

## STEP 4 — Put your secret keys in the app

1. In the project folder, copy `.env.example` and rename the copy to `.env`.
2. Fill in each value:
   - `OPENAI_API_KEY` — from OpenAI dashboard
   - `D360_API_KEY` — from 360dialog dashboard
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the whole JSON as ONE line
   - `GOOGLE_SHEET_ID` — from Step 3
   - `WEBHOOK_VERIFY_TOKEN` — invent any secret word (e.g. `dfh-secret-2025`)

> ⚠️ The `.env` file holds your secrets. Never email it, never put it on the public internet.

---

## STEP 5 — Run it locally first (developer tests on their laptop)

```bash
npm install        # downloads the building blocks (one time)
npm start          # starts the receptionist
```
Open `http://localhost:3000` — you should see "is running ✅".
Open `http://localhost:3000/dashboard` — you should see the empty dashboard.

---

## STEP 6 — Put it online (Railway)

1. Push this folder to a GitHub repository (developer does this).
2. On Railway: **New Project → Deploy from GitHub** → pick the repo.
3. In Railway → **Variables**, add every line from your `.env` file.
4. Railway gives you a public web address like `https://your-app.up.railway.app`.

---

## STEP 7 — Connect WhatsApp (360dialog)

1. In 360dialog, set your **webhook URL** to:
   `https://your-app.up.railway.app/webhook`
2. 360dialog will "verify" it using your `WEBHOOK_VERIFY_TOKEN`. The app handles this automatically.
3. Done — now any WhatsApp message to your business number reaches your AI receptionist.

---

## STEP 8 — Test it

From your personal WhatsApp, message your hospital number:
- "Gynae doctor kab baithti hain?"
- "PRP ki fee kya hai?"
- "Address bhej dein"

You should get natural Urdu replies based on your Sheet. Check `/dashboard` — the leads appear.

---

## Phase 1 cost estimate (small volume, ~500 chats/month)

| Service | Cost |
|--------|------|
| OpenAI (GPT-4o, text only) | ~$10–30 |
| 360dialog WhatsApp | ~$10–25 + per-conversation fees |
| Railway hosting | ~$5 |
| Google Sheets | Free |
| **Total** | **~$25–60 / month** |

---

## What's NOT in Phase 1 (coming next)
- 🎤 Voice notes in & Urdu voice replies out → **Phase 2**
- 📅 Real appointment booking/reschedule/cancel → **Phase 3**
- 📊 Advanced dashboard, human-handover routing, hospital-software/lab integration → **Phase 4**

When Phase 1 is working and you've sent a few test messages, tell me and we'll build Phase 2.
