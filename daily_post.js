import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const GROQ_KEY = process.env.GROQ_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GROQ_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  throw new Error("Missing GROQ_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars");
}

// ---------- 1. Pull real headlines from free RSS feeds ----------
const FEEDS = [
  "https://feeds.bbci.co.uk/news/politics/rss.xml",
  "https://www.theguardian.com/politics/rss",
  "https://feeds.skynews.com/feeds/rss/politics.xml"
];

const PRIORITY = [
  { tags: ["scandal", "resign", "minister", "pm ", "prime minister", "sleaze", "inquiry", "misled", "parliament"], weight: 5 },
  { tags: ["nhs", "hospital", "doctor", "nurse", "health service"], weight: 4 },
  { tags: ["cost of living", "energy bill", "inflation", "tax", "budget", "mortgage"], weight: 3 },
  { tags: ["migrant", "immigration", "asylum", "border"], weight: 2 },
  { tags: ["trump", "us relations", "washington", "tariff"], weight: 1 }
];

async function fetchFeedItems(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map(it => ({
    title: String(it.title || "").trim(),
    description: String(it.description || "").replace(/<[^>]+>/g, "").trim()
  })).filter(it => it.title);
}

function scoreItem(item) {
  const text = (item.title + " " + item.description).toLowerCase();
  let score = 0;
  for (const p of PRIORITY) {
    if (p.tags.some(t => text.includes(t))) score += p.weight;
  }
  return score;
}

async function pickTopStory() {
  const allItems = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeedItems(feed);
      allItems.push(...items.slice(0, 15));
    } catch (e) {
      console.warn("Feed failed:", feed, e.message);
    }
  }
  if (allItems.length === 0) throw new Error("No RSS items fetched from any feed");
  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));
  return allItems[0];
}

// ---------- 2. Free LLM (Groq) writes the post package ----------
async function writePostPackage(story) {
  const instruction = `You write posts for a UK political commentary page called "The Honest Brit" (direct, bold, binary YES/NO polls, neutral framing of both sides).

Today's real news story:
Title: ${story.title}
Description: ${story.description}

Turn this into a post package. Rules:
- image_scene MUST create a dramatic political poster composition matching this exact style:
  • Left side: a realistic, serious-looking British politician (or the main figure in the story) standing at a podium / speaking, three-quarter view, sharp suit, dramatic side lighting
  • Right side: a large, shadowed, stern close-up face of another relevant older political figure or opposing figure
  • Small secondary figure lower right if the story involves more than one person
  • Dark moody background with heavy distressed Union Jack texture, cinematic high-contrast lighting, smoke/embers optional
  • NO logos, NO text, NO watermarks inside the scene itself
- Keep summary factual and neutral. Poll options must be 1-2 words each.

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{
  "headline": "3-6 words, ALL CAPS, punchy",
  "summary": "2-3 factual sentences on the story",
  "quote_or_stat": "1-2 sentences with a key detail or figure from the description",
  "poll_question": "bold binary question, one sentence",
  "left_option": "1-2 words",
  "left_explain": "brief explanation of this position",
  "right_option": "1-2 words",
  "right_explain": "brief explanation of this position",
  "hashtags_main": ["#TheHonestBrit","#UKPolitics","#Topic1","#Topic2"],
  "hashtags_extra": ["#...", "up to 20 total discovery tags"],
  "image_scene": "40-70 word detailed visual description of the dramatic political poster composition described above"
}`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: instruction }],
      temperature: 0.75
    })
  });

  if (!resp.ok) throw new Error(`Groq API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not find JSON in model output:\n" + text);
  return JSON.parse(match[0]);
}

// ---------- 3. Build the image – matches the uploaded style ----------
async function buildImage(pkg) {
  // Force the exact visual language of the uploaded post
  const scenePrompt = `${pkg.image_scene}, dark moody cinematic political poster, heavy distressed Union Jack flag texture in the background, dramatic high-contrast lighting, photorealistic, 8k, no text, no logos, no watermarks`;

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scenePrompt)}?width=1080&height=1350&nologo=true&seed=${Date.now() % 1000000}`;
  const bgResp = await fetch(url);
  if (!bgResp.ok) throw new Error("pollinations fetch failed: " + bgResp.status);
  const bgBuffer = Buffer.from(await bgResp.arrayBuffer());

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Layout matched to the uploaded example
  const overlaySvg = `
  <svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.55"/>
        <stop offset="0.35" stop-color="#000" stop-opacity="0.15"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.55" stop-color="#000" stop-opacity="0.4"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.85"/>
      </linearGradient>
    </defs>

    <!-- Subtle dark overlays -->
    <rect width="1080" height="1350" fill="url(#topFade)"/>
    <rect width="1080" height="1350" fill="url(#bottomFade)"/>

    <!-- MAIN HEADLINE – huge, white, thick red outline (matches uploaded) -->
    <text x="540" y="210" font-family="Arial Black, Impact, sans-serif" font-size="92" font-weight="900"
          fill="#ffffff" stroke="#c1122f" stroke-width="8" text-anchor="middle"
          textLength="980" lengthAdjust="spacingAndGlyphs">
      ${esc(pkg.headline)}
    </text>

    <!-- Bottom black rounded poll bar (exact style of uploaded post) -->
    <rect x="60" y="1080" width="960" height="200" rx="28" ry="28" fill="#111111" fill-opacity="0.92"/>

    <!-- Poll question inside the black bar -->
    <text x="540" y="1155" font-family="Arial, sans-serif" font-size="36" font-weight="700"
          fill="#ffffff" text-anchor="middle" textLength="880" lengthAdjust="spacing">
      ${esc(pkg.poll_question)}
    </text>

    <!-- YES option (left) -->
    <circle cx="280" cy="1225" r="32" fill="#2f6fed" stroke="#ffffff" stroke-width="3"/>
    <text x="280" y="1238" font-family="Arial, sans-serif" font-size="34" text-anchor="middle" fill="#ffffff">👍</text>
    <text x="340" y="1238" font-family="Arial Black, Arial, sans-serif" font-size="38" font-weight="800" fill="#ffffff">
      ${esc(pkg.left_option)}
    </text>

    <!-- NO option (right) -->
    <circle cx="680" cy="1225" r="32" fill="#e0457b" stroke="#ffffff" stroke-width="3"/>
    <text x="680" y="1238" font-family="Arial, sans-serif" font-size="34" text-anchor="middle" fill="#ffffff">❤️</text>
    <text x="740" y="1238" font-family="Arial Black, Arial, sans-serif" font-size="38" font-weight="800" fill="#ffffff">
      ${esc(pkg.right_option)}
    </text>
  </svg>`;

  return sharp(bgBuffer)
    .resize(1080, 1350)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .jpeg({ quality: 93 })
    .toBuffer();
}

// ---------- 4. Caption ----------
function buildCaption(pkg) {
  return `🇬🇧 BE HONEST.

${pkg.summary}

${pkg.quote_or_stat}

${pkg.poll_question}

👍 ${pkg.left_option} — ${pkg.left_explain}
❤️ ${pkg.right_option} — ${pkg.right_explain}

Drop your honest take below. No spin. Just the question. 👇

Follow The Honest Brit for the UK's most direct political pulse check. 🇬🇧

BE

${pkg.hashtags_main.join(" ")}`;
}

// ---------- Dynamic posting time table ----------
function postingTimeTable() {
  const now = new Date();
  const ukTime = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const sriTime = now.toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false });
  return `| Time Zone | Current Time |
| :--- | :--- |
| UK (BST/GMT) | ${ukTime} |
| Sri Lanka (SLST) | ${sriTime} |`;
}

// ---------- 5. Send to Telegram ----------
async function sendToTelegram(imageBuffer, pkg) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "post.jpg");

  const photoResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  if (!photoResp.ok) throw new Error("Telegram sendPhoto failed: " + (await photoResp.text()));

  const caption = buildCaption(pkg);

  // Message 1: caption only (easy to copy)
  const captionResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: caption })
  });
  if (!captionResp.ok) throw new Error("Telegram sendMessage (caption) failed: " + (await captionResp.text()));

  // Message 2: extras
  const extraTags = pkg.hashtags_extra?.join(" ") || "";
  const extrasMsg = `🏷 Pinned comment tags:\n${extraTags}\n\n🕒 Posting time:\n${postingTimeTable()}`;
  const extrasResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: extrasMsg })
  });
  if (!extrasResp.ok) throw new Error("Telegram sendMessage (extras) failed: " + (await extrasResp.text()));
}

// ---------- run ----------
(async () => {
  console.log("Reading RSS feeds for today's top story...");
  const story = await pickTopStory();
  console.log("Story:", story.title);

  console.log("Writing post package (Groq)...");
  const pkg = await writePostPackage(story);
  console.log("Headline:", pkg.headline);

  console.log("Building image (Pollinations + SVG overlay matching your example)...");
  const image = await buildImage(pkg);

  console.log("Sending to Telegram...");
  await sendToTelegram(image, pkg);
  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
