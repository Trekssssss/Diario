# Diario — Spanish journal → corrections → Anki cards

Tell your day in Spanish on the iPad — by typing (**Escribir**) or by voice (**Hablar**: the recording is transcribed with your mistakes kept, then you can edit the text). Both paths lead to the same flow:

1. **Entrada** — write or dictate today's entry.
2. **Revisión** — corrected version, your mistakes with clear explanations (tense changes always say why), a "Más información" fold with the rule + examples, and a "Preguntar" button to ask the teacher a follow-up question about any mistake.
3. **Tarjetas** — 5 flashcards (configurable): a realistic everyday sentence with a blank, you type the missing word. No hints on the front.

The home screen shows your streak (current, best, last 14 days), and the **Calendario** tab lets you tap any day to reread that entry. In **Ajustes** you pick the country whose Spanish you want (Mexico, Spain, Argentina…) and which areas to get feedback on (grammar, verb tenses, spelling/accents, vocabulary, naturalness).

One tap on **"Añadir a Anki"** builds a small `.apkg` file and opens the iPad share sheet. Choose **AnkiMobile** and the cards are merged into your deck. They sync through AnkiWeb like any other card.

Cards are picked in this order: words you wrote in English/French → words you misused → basic vocabulary you lack for the topic → common natural expressions. Words already sent to Anki are not repeated.

## Setup (all doable from Safari on the iPad)

1. **Vercel**: vercel.com → *Add New… → Project* → import this GitHub repo. Framework preset: **Other**. No build command.
2. Before clicking *Deploy*, open **Environment Variables** and add:
   - `OPENROUTER_API_KEY` = your OpenRouter key
   - `APP_PASSCODE` = any word you choose (stops strangers from spending your credits)
   - optional `OPENROUTER_MODEL` = any OpenRouter model id (default `anthropic/claude-haiku-5.5`, under 1 cent per entry)
   - optional `OPENROUTER_TRANSCRIBE_MODEL` = audio-capable model for voice entries (default `google/gemini-2.5-flash`, well under 1 cent per recording)
3. Deploy, open the URL in Safari → Share → **Add to Home Screen** (this also stops Safari from clearing your journal).
4. In the app, go to **Ajustes**: type your passcode and the **exact name of your Anki deck** (e.g. `Español`).

If you change an environment variable later, redeploy (Deployments → ⋯ → Redeploy).

## Your data

Your journal entries live on the iPad (browser storage). Use **Ajustes → Descargar copia** now and then to keep a backup file; **Restaurar copia** brings it back.

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `recorder.js` — microphone capture for voice entries (mp3 encoded in the browser with lamejs from a CDN)
- `apkg.js` — builds the Anki deck file in the browser (sql.js + JSZip from a CDN)
- `api/correct.js` — corrections; `api/transcribe.js` — voice → text; `api/followup.js` — questions about a mistake. All three call OpenRouter; the key never reaches the browser
