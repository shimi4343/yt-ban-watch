import fs from "fs/promises";
import path from "path";
import process from "process";
import * as url from "url";
import dotenv from "dotenv";
import cheerio from "cheerio";

dotenv.config();

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "state.json");

const BASE_URL = process.env.BASE_URL || "https://yutura.net";
const BANNED_PATH = process.env.BANNED_PATH || "/banned/";
const PAGES = Number(process.env.PAGES || 1);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (compatible; YtBanWatch/1.0)";

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL を .env に設定してください。");
  process.exit(1);
}

// ---- helpers
async function loadState() {
  try {
    const txt = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(txt);
  } catch {
    return { notifiedChannelIds: {} }; // { [channelNumericId]: isoDateNotified }
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function fetchHtml(urlStr) {
  const res = await fetch(urlStr, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${urlStr}`);
  return await res.text();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absolutize(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return new URL(href, BASE_URL).toString();
}

// ---- scraping
function extractChannelLinksFromBanned(html) {
  const $ = cheerio.load(html);
  // 「チャンネルの詳細」リンク or /channel/数字/ を拾う
  const links = new Set();
  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (/^\/channel\/\d+\/?$/.test(href)) {
      links.add(absolutize(href));
    }
  });
  return Array.from(links);
}

function parseBanInfoFromChannelPage(html, pageUrl) {
  const $ = cheerio.load(html);

  const titleText =
    $("h1").first().text().trim() ||
    $("title").first().text().replace(/｜.*$/, "").trim();

  const suspended = $("*")
    .toArray()
    .some((el) => $(el).text().includes("このチャンネルは現在停止されています"));

  // BANニュースの「YYYY年M月D日」を優先的に拾う
  let banDateJp = null;
  let banNewsFound = false;
  $("*").each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes("BANされました")) {
      banNewsFound = true;
      // 同じノード/近傍に日付が含まれているケースが多い
      const m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (m) {
        banDateJp = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      }
    }
  });

  // YouTube 公式リンク（ヘッダー直下にあることが多い）
  const youtubeUrl =
    $('a[href^="https://www.youtube.com"]').first().attr("href") || null;

  // 数字のチャンネルID（/channel/12345/ の 12345）を抜き出す
  const idMatch = pageUrl.match(/\/channel\/(\d+)\//);
  const yuturaId = idMatch ? idMatch[1] : null;

  return {
    title: titleText || null,
    yuturaId,
    pageUrl,
    youtubeUrl,
    suspended,
    banNewsFound,
    banDate: banDateJp, // ISO-ish (YYYY-MM-DD) or null
  };
}

// ---- discord
async function notifyDiscord(embed) {
  const payload = {
    username: "Yutura BAN Watch",
    embeds: [embed],
  };
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook error ${res.status}: ${text}`);
  }
}

// ---- main
async function main() {
  const state = await loadState();
  const notified = state.notifiedChannelIds || {};

  const bannedPages = Array.from({ length: PAGES }, (_, i) =>
    new URL(`${BANNED_PATH}${i === 0 ? "" : i + 1 + "/"}`, BASE_URL).toString()
  );

  const channelPageUrls = [];
  for (const pageUrl of bannedPages) {
    const html = await fetchHtml(pageUrl);
    const links = extractChannelLinksFromBanned(html);
    channelPageUrls.push(...links);
    await sleep(1500); // やさしめ
  }

  // 新規のみ
  const targets = channelPageUrls.filter((u) => {
    const m = u.match(/\/channel\/(\d+)\//);
    const id = m ? m[1] : null;
    return id && !notified[id];
  });

  for (const chUrl of targets) {
    try {
      const html = await fetchHtml(chUrl);
      const info = parseBanInfoFromChannelPage(html, chUrl);

      // BANと判断できる根拠がある場合のみ通知
      if (info.suspended || info.banNewsFound) {
        const embed = {
          title: `BAN検知：${info.title ?? "不明"}`,
          url: info.pageUrl,
          description:
            "ユーチュラのチャンネル詳細でBANが確認されました。",
          fields: [
            info.banDate ? { name: "BAN日", value: info.banDate, inline: true } : null,
            info.youtubeUrl ? { name: "YouTube", value: info.youtubeUrl, inline: false } : null,
            { name: "ユーチュラ", value: info.pageUrl, inline: false },
          ].filter(Boolean),
          timestamp: new Date().toISOString(),
        };

        await notifyDiscord(embed);

        // 記録
        if (info.yuturaId) {
          notified[info.yuturaId] = new Date().toISOString();
          await saveState({ notifiedChannelIds: notified });
        }
      }

      await sleep(1500);
    } catch (e) {
      console.error(`Error on ${chUrl}:`, e.message);
      await sleep(2000);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});