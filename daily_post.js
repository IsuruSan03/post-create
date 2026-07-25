import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const GROQ_KEY = process.env.GROQ_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GROQ_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  throw new Error("Missing GROQ_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars");
}

// ---------- 1. RSS ----------
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
  if (allItems.length === 0) throw new Error("No RSS items fetched");
  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));
  return allItems[0];
}

// ---------- 2. Groq ----------
async function writePostPackage(story) {
  const instruction = `You write posts for "The Honest Brit" – a direct UK political page.

Story:
Title: ${story.title}
Description: ${story.description}

Create the package. CRITICAL rules for image_scene:
- Describe ONLY this exact composition:
  Left half: a realistic British male politician in a dark suit standing at a wooden podium with a microphone, three-quarter view, looking slightly to the side or speaking, strong lighting on his face
  Right half: a large, close-up, dramatic, heavily shadowed older male political face filling most of the right side
  Lower right: a small, distant secondary figure of another man
  Background: heavy distressed Union Jack flag texture, very dark and moody
  Lighting: cinematic, high contrast, dramatic side light, slight atmospheric haze
  NO text, NO logos, NO watermarks anywhere in the scene

Respond with ONLY raw JSON:
{
  "headline": "3-6 words ALL CAPS punchy",
  "summary": "2-3 factual sentences",
  "quote_or_stat": "1-2 key details",
  "poll_question": "clear binary question in ALL CAPS if possible",
  "left_option": "YES",
  "left_explain": "short reason",
  "right_option": "NO",
  "right_explain": "short reason",
  "hashtags_main": ["#TheHonestBrit","#UKPolitics","#Topic1","#Topic2"],
  "hashtags_extra": ["#tag1","#tag2","..."],
  "image_scene": "55-75 word description of the exact left-podium + right-large-shadowed-face composition above"
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
      temperature: 0.65
    })
  });

  if (!resp.ok) throw new Error(`Groq error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found:\n" + text);
  return JSON.parse(match[0]);
}

// ---------- 3. Image – locked to your target photo ----------
async function buildImage(pkg) {
  const scenePrompt = `${pkg.image_scene}, dark cinematic political poster, heavy distressed Union Jack background, dramatic high-contrast lighting, photorealistic, 8k, no text, no logos`;

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scenePrompt)}?width=1080&height=1350&nologo=true&seed=${Date.now() % 1000000}`;
  const bgResp = await fetch(url);
  if (!bgResp.ok) throw new Error("Image generation failed: " + bgResp.status);
  const bgBuffer = Buffer.from(await bgResp.arrayBuffer());

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // This SVG is carefully matched to the proportions and style of your target image
  const overlaySvg = `
<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="topDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.7"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bottomDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="50%" stop-color="#000" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.92"/>
    </linearGradient>
  </defs>

  <!-- Dark overlays for text readability -->
  <rect width="1080" height="1350" fill="url(#topDark)"/>
  <rect width="1080" height="1350" fill="url(#bottomDark)"/>

  <!-- ========== MAIN HEADLINE ========== -->
  <!-- Pure white fill + thick red outline – exact match to target -->
  <text x="540" y="210"
        font-family="Arial Black, Impact, sans-serif"
        font-size="96"
        font-weight="900"
        fill="#FFFFFF"
        stroke="#C1122F"
        stroke-width="10"
        text-anchor="middle"
        textLength="980"
        lengthAdjust="spacingAndGlyphs">
    ${esc(pkg.headline)}
  </text>

  <!-- ========== BOTTOM POLL BAR ========== -->
  <rect x="40" y="1070" width="1000" height="240" rx="36" ry="36" fill="#111111" fill-opacity="0.95"/>

  <!-- Poll question – large and clear -->
  <text x="540" y="1160"
        font-family="Arial, Helvetica, sans-serif"
        font-size="38"
        font-weight="700"
        fill="#FFFFFF"
        text-anchor="middle"
        textLength="920"
        lengthAdjust="spacing">
    ${esc(pkg.poll_question)}
  </text>

  <!-- YES button -->
  <circle cx="280" cy="1245" r="38" fill="#2F6FED" stroke="#FFFFFF" stroke-width="4"/>
  <text x="280" y="1260" font-size="42" text-anchor="middle" fill="#FFFFFF">👍</text>
  <text x="350" y="1260"
        font-family="Arial Black, Arial, sans-serif"
        font-size="44"
        font-weight="800"
        fill="#FFFFFF">
    ${esc(pkg.left_option)}
  </text>

  <!-- NO button -->
  <circle cx="700" cy="1245" r="38" fill="#E0457B" stroke="#FFFFFF" stroke-width="4"/>
  <text x="700" y="1260" font-size="42" text-anchor="middle" fill="#FFFFFF">❤️</text>
  <text x="770" y="1260"
        font-family="Arial Black, Arial, sans-serif"
        font-size="44"
        font-weight="800"
        fill="#FFFFFF">
    ${esc(pkg.right_option)}
  </text>
</svg>`;

  return sharp(bgBuffer)
    .resize(1080, 1350)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .jpeg({ quality: 94 })
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

// ---------- 5. Time table ----------
function postingTimeTable() {
  const now = new Date();
  const ukTime = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const sriTime = now.toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false });
  return `| Time Zone | Current Time |
| :--- | :--- |
| UK (BST/GMT) | ${ukTime} |
| Sri Lanka (SLST) | ${sriTime} |`;
}

// ---------- 6. Telegram ----------
async function sendToTelegram(imageBuffer, pkg) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "post.jpg");

  const photoResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  if (!photoResp.ok) throw new Error("sendPhoto failed: " + await photoResp.text());

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: buildCaption(pkg) })
  });

  const extraTags = pkg.hashtags_extra?.join(" ") || "";
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: `🏷 Pinned comment tags:\n${extraTags}\n\n🕒 Posting time:\n${postingTimeTable()}`
    })
  });
}

// ---------- Run ----------
(async () => {
  console.log("Fetching top story...");
  const story = await pickTopStory();
  console.log("Story:", story.title);

  console.log("Writing package...");
  const pkg = await writePostPackage(story);
  console.log("Headline:", pkg.headline);

  console.log("Building image (target style locked)...");
  const image = await buildImage(pkg);

  console.log("Sending...");
  await sendToTelegram(image, pkg);
  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
