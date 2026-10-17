# Diario — Spanish journal → corrections → Anki cards

Write your daily journal in Spanish on the iPad. Three steps:

1. **Escribir** — write today's entry.
2. **Revisión** — corrected version, your mistakes with short explanations, tips to sound more natural, and 2–3 things to look up today (with search and video links).
3. **Tarjetas** — 5 flashcards (configurable): a realistic everyday sentence with a blank, you type the missing word. No hints on the front.

One tap on **"Añadir a Anki"** builds a small `.apkg` file and opens the iPad share sheet. Choose **AnkiMobile** and the cards are merged into your deck. They sync through AnkiWeb like any other card.

Cards are picked in this order: words you wrote in English/French → words you misused → basic vocabulary you lack for the topic → common natural expressions. Words already sent to Anki are not repeated.

## Setup (all doable from Safari on the iPad)

1. **Vercel**: vercel.com → *Add New… → Project* → import this GitHub repo. Framework preset: **Other**. No build command.
2. Before clicking *Deploy*, open **Environment Variables** and add:
   - `OPENROUTER_API_KEY` = your OpenRouter key
   - `APP_PASSCODE` = any word you choose (stops strangers from spending your credits)
   - optional `OPENROUTER_MODEL` = any OpenRouter model id (default `anthropic/claude-haiku-5.5`, under 1 cent per entry)
3. Deploy, open the URL in Safari → Share → **Add to Home Screen** (this also stops Safari from clearing your journal).
4. In the app, go to **Ajustes**: type your passcode and the **exact name of your Anki deck** (e.g. `Español`).

If you change an environment variable later, redeploy (Deployments → ⋯ → Redeploy).

## Your data

Your journal entries live on the iPad (browser storage). Use **Ajustes → Descargar copia** now and then to keep a backup file; **Restaurar copia** brings it back.

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `apkg.js` — builds the Anki deck file in the browser (sql.js + JSZip from a CDN)
- `api/correct.js` — serverless function that calls OpenRouter; the key never reaches the browser
