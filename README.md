# Honest Brit — daily auto post (100% free version)

Runs once a day on GitHub Actions. No server, no local machine, no paid API.

## What it does
1. Reads today's real headlines from free RSS feeds (BBC, Guardian, Sky News — UK politics) and picks the highest-priority story using the same ranking as your manual process (scandal → NHS → cost of living → immigration → UK-US).
2. Sends that real headline to **Groq's free API** (Llama 3.3 70B) to write the headline, caption, poll question/options, hashtags, and a symbolic image-scene description.
3. Builds a 1080×1080 image: free background art from pollinations.ai + your exact headline/poll-bar layout burned on top with crisp text via `sharp`.
4. Sends the photo to your Telegram chat, then a second message with the ready-to-paste caption, extra hashtags, and posting-time table.
5. You open Telegram, download the photo, copy the caption, paste both into Facebook.

## Cost: $0
- GitHub Actions — free (public repo: unlimited; private: 2,000 free min/month, this job takes seconds)
- RSS feeds — free, no key
- Groq API — free tier, no card required
- pollinations.ai — free, no key
- Telegram Bot API — free

## Why no real politician faces in the image
Photorealistic AI images of real named people (Starmer, Trump, etc.) posed in fabricated scenes are the kind of synthetic media that gets mistaken for real news photos — that part isn't automated. Everything else (headline, Union Jack styling, poll bar, buttons, caption, hashtags, scheduling) matches your template exactly, with a symbolic/graphic center image instead of a fake photo of a real person.

## Setup

### 1. Get a free Groq API key
- Go to https://console.groq.com → sign up (no card needed) → **API Keys** → Create key.

### 2. Push this folder to a GitHub repo

### 3. Add repo secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add three, **one at a time** (name + value, then "Add secret", repeat):
- `GROQ_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### 4. Test it
Repo → **Actions** tab → "Daily Honest Brit Post" → **Run workflow**.

It also runs automatically every day at 16:30 UTC — edit the cron line in `.github/workflows/daily-post.yml` to change the time.

## Local test (optional)
```
npm install
GROQ_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm start
```
