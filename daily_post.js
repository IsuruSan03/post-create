import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const GROQ_KEY = process.env.GROQ_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GROQ_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  throw new Error("Missing GROQ_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars");
}

// ---------- 1. Pull real headlines ----------
const FEEDS = [
  "https://feeds.bbci.co.uk/news/politics/rss.xml",
  "https://www.theguardian.com/politics/rss",
  "https://feeds.skynews.com/feeds/rss/politics.xml"
];

const PRIORITY = [
  { tags: ["scandal", "resign", "minister", "pm ", "prime minister", "sleaze", "inquiry", "misled", "parliament"], weight: 5 },
  { tags: ["nhs", "hospital", "doctor", "nurse", "health service"], weight: 4 },
  { tags: ["cost of living", "energy bill", "inflation", "tax", "budget", "mortgage", "elite", "rich"], weight: 3 },
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

// ---------- 2. Groq writes the package ----------
async function writePostPackage(story) {
  const instruction = `You write posts for a UK political commentary page called "The Honest Brit".

Today's real news story:
Title: ${story.title}
Description: ${story.description}

Create a post package. Rules for image_scene (VERY IMPORTANT):
- Must describe a dramatic political poster composition exactly like this:
  • Left side: a realistic British politician standing at a wooden podium, three-quarter view, speaking or looking serious, sharp dark suit, strong side lighting
  • Right side: a large, close-up, heavily shadowed, stern older face of another relevant political figure filling most of the right half
  • Optional small secondary figure visible in the lower right background
  • Heavy distressed Union Jack flag texture across the entire background
  • Extremely dark, moody, cinematic high-contrast lighting, slight smoke or ember effects allowed
  • NO text, NO logos, NO watermarks inside the scene
- Headline must be 3-6 words, ALL CAPS, punchy
- Poll options = 1-2 words only

Respond with ONLY raw JSON, no markdown, no explanation:
{
  "headline": "3-6 words ALL CAPS",
  "summary": "2-3 factual sentences",
  "quote_or_stat": "1-2 key sentences or figures",
  "poll_question": "one clear binary question",
  "left_option": "Yes or 1-2 words",
  "left_explain": "short explanation",
  "right_option": "No or 1-2 words",
  "right_explain": "short explanation",
  "hashtags_main": ["#TheHonestBrit","#UKPolitics","#Topic1","#Topic2"],
  "hashtags_extra": ["#tag1", "#tag2", "... up to 20"],
  "image_scene": "45-70 word detailed description of the exact left-podium + right-shadowed-face composition described above"
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
      temperature: 0.7
    })
  });

  if (!resp.ok) throw new Error(`Groq API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not find JSON in model output:\n" + text);
  return JSON.parse(match[0]);
}

// ---------- 3. Build image – locked to your first example style ----------
async function buildImage(pkg) {
  const scenePrompt = `${pkg.image_scene}, dark moody cinematic political poster style, heavy distressed Union Jack flag texture background, dramatic high-contrast side lighting, photorealistic, 8k, no text, no logos, no watermarks`;

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scenePrompt)}?width=1080&height=1350&nologo=true&seed=${Date.now() % 1000000}`;
  const bgResp = await fetch(url);
  if (!bgResp.ok) throw new Error("pollinations fetch failed: " + bgResp.status);
  const bgBuffer = Buffer.from(await bgResp.arrayBuffer());

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Exact layout matching your first uploaded post
  const overlaySvg = `
  <svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.65"/>
        <stop offset="0.4" stop-color="#000" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.5" stop-color="#000" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.9"/>
      </linearGradient>
    </defs>

    <rect width="1080" height="1350" fill="url(#topFade)"/>
    <rect width="1080" height="1350" fill="url(#bottomFade)"/>

    <!-- HEADLINE: pure white + thick red outline (matches your first post) -->
    <text x="540" y="195"
          font-family="Arial Black, Impact, sans-serif"
          font-size="88" font-weight="900"
          fill="#ffffff"
          stroke="#c1122f" stroke-width="9"
          text-anchor="middle"
          textLength="960" lengthAdjust="spacingAndGlyphs">
      ${esc(pkg.headline)}
    </text>

    <!-- Bottom black rounded poll bar -->
    <rect x="50" y="1095" width="980" height="210" rx="32" ry="32" fill="#0d0d0d" fill-opacity="0.94"/>

    <!-- Full poll question -->
    <text x="540" y="1175"
          font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700"
          fill="#ffffff"
          text-anchor="middle"
          textLength="900" lengthAdjust="spacing">
      ${esc(pkg.poll_question)}
    </text>

    <!-- YES (left) – blue circle + 👍 -->
    <circle cx="260" cy="1245" r="34" fill="#2f6fed" stroke="#ffffff" stroke-width="3.5"/>
    <text x="260" y="1259" font-family="Arial" font-size="36" text-anchor="middle" fill="#ffffff">👍</text>
    <text x="320" y="1259"
          font-family="Arial Black, Arial, sans-serif"
          font-size="40" font-weight="800" fill="#ffffff">
      ${esc(pkg.left_option)}
    </text>

    <!-- NO (right) – pink circle + ❤️ -->
    <circle cx="680" cy="1245" r="34" fill="#e0457b" stroke="#ffffff" stroke-width="3.5"/>
    <text x="680" y="1259" font-family="Arial" font-size="36" text-anchor="middle" fill="#ffffff">❤️</text>
    <text x="740" y="1259"
          font-family="Arial Black, Arial, sans-serif"
          font-size="40" font-weight="800" fill="#ffffff">
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

// ---------- 5. Posting time table ----------
function postingTimeTable() {
  const now = new Date();
  const ukTime = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const sriTime = now.toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false });
  return `| Time Zone | Current Time |
| :--- | :--- |
| UK (BST/GMT) | ${ukTime} |
| Sri Lanka (SLST) | ${sriTime} |`;
}

// ---------- 6. Send to Telegram ----------
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

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: caption })
  });

  const extraTags = pkg.hashtags_extra?.join(" ") || "";
  const extrasMsg = `🏷 Pinned comment tags:\n${extraTags}\n\n🕒 Posting time:\n${postingTimeTable()}`;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: extrasMsg })
  });
}

// ---------- run ----------
(async () => {
  console.log("Reading RSS feeds...");
  const story = await pickTopStory();
  console.log("Story:", story.title);

  console.log("Writing post package...");
  const pkg = await writePostPackage(story);
  console.log("Headline:", pkg.headline);

  console.log("Building image (locked to your target style)...");
  const image = await buildImage(pkg);

  console.log("Sending to Telegram...");
  await sendToTelegram(image, pkg);
  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
