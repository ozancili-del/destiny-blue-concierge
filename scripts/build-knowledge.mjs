// scripts/build-knowledge.js
// Lightweight crawler that builds docs/knowledge.json from your sitemap.
// No external dependencies needed (runs on Node.js 20+ in GitHub Actions).

import fs from "node:fs/promises";
import path from "node:path";

const SITEMAP_URL = process.env.SITEMAP_URL || "https://www.destincondogetaways.com/sitemap.xml";
const BASE = new URL(SITEMAP_URL).origin;
const LIMIT = parseInt(process.env.PAGE_LIMIT || "40", 10); // cap the number of pages

function textBetween(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : null;
}
function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : "";
}
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}
function stripHtml(html) {
  if (!html) return "";
  // remove scripts/styles/comments
  html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
             .replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<!--[\s\S]*?-->/g, " ");
  // add line breaks after block tags for nicer text
  html = html.replace(/<\/(p|br|h[1-6]|li|div|section|article|main)>/gi, "\n");
  // strip tags
  html = html.replace(/<[^>]+>/g, " ");
  // collapse spaces
  return html.replace(/\s+/g, " ").trim();
}
function pickMainContent(rawHtml) {
  const candidates = [
    textBetween(rawHtml, "main"),
    textBetween(rawHtml, "article"),
    // some sites use #content or .content; try coarse matches:
    (rawHtml.match(/<[^>]+id=["']content["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || [null, null])[1],
    (rawHtml.match(/<[^>]+class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || [null, null])[1],
    textBetween(rawHtml, "body")
  ];
  for (const c of candidates) {
    const t = stripHtml(c);
    if (t && t.length > 500) return t;
  }
  return stripHtml(rawHtml);
}
function extractEmail(text) {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return m ? m[0] : "";
}
function findTime(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1] : "";
}
function guessBasics(allText) {
  const lower = allText.toLowerCase();

  const wifi = lower.includes("wi-fi") || lower.includes("wifi") ? "Wi-Fi available. Details provided in arrival info." : "";
  const parking = lower.includes("parking")
    ? "Parking available (see booking/arrival details for specifics)."
    : "";

  // simple time guesses
  const checkIn  = findTime(lower, /check[\s-]?in[^0-9]{0,20}(\d{1,2}(:\d{2})?\s?(am|pm))/i)  || "";
  const checkOut = findTime(lower, /check[\s-]?out[^0-9]{0,20}(\d{1,2}(:\d{2})?\s?(am|pm))/i) || "";

  return {
    checkIn:  checkIn  || undefined,
    checkOut: checkOut || undefined,
    wifi:     wifi     || undefined,
    parking:  parking  || undefined
  };
}

async function getSitemapUrls(xml) {
  const urls = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    const u = m[1].trim();
    if (u.startsWith(BASE)) urls.push(u);
  }
  return urls;
}

async function main() {
  console.log("Fetching sitemap:", SITEMAP_URL);
  const xml = await (await fetch(SITEMAP_URL)).text();
  let urls = await getSitemapUrls(xml);
  // optional: de-duplicate + basic filtering
  urls = Array.from(new Set(urls)).filter(u => !u.endsWith(".xml"));
  urls = urls.slice(0, LIMIT);
  console.log("Found URLs:", urls.length);

  const docs = [];
  let contactEmail = "";

  for (const url of urls) {
    try {
      console.log("Fetching", url);
      const html = await (await fetch(url, { redirect: "follow" })).text();
      const title = extractTitle(html) || url;
      const desc  = extractMetaDescription(html);
      const body  = pickMainContent(html);
      const text  = (desc ? (desc + "\n\n") : "") + body;

      if (!contactEmail) {
        const e = extractEmail(text);
        if (e) contactEmail = e;
      }

      docs.push({
        title,
        url,
        content: text.slice(0, 4000) // keep it lightweight
      });
    } catch (e) {
      console.warn("Failed:", url, e.message);
    }
  }

  const bigBlob = docs.map(d => d.title + "\n" + d.content).join("\n\n");
  const basics = guessBasics(bigBlob);

  const knowledge = {
    propertyName: "Destin Condo Getaways",
    contact: { ownerEmail: contactEmail || "info@destincondogetaways.com" },
    basics,
    policies: {},
    amenities: {},
    faqs: [
      { tags: ["wifi","internet","wi-fi"], q: "Do you have Wi-Fi?", a: basics.wifi || "Yes—Wi-Fi available. Details in your arrival email." },
      { tags: ["parking","car"], q: "Is parking available?", a: basics.parking || "Parking details are in your arrival information." },
      { tags: ["check-in","arrival"], q: "What time is check-in?", a: basics.checkIn ? `Check-in is around ${basics.checkIn}.` : "Check-in time is provided in your arrival email." },
      { tags: ["checkout","departure"], q: "What time is check-out?", a: basics.checkOut ? `Check-out is around ${basics.checkOut}.` : "Check-out time is provided in your arrival email." }
    ],
    docs
  };

  const outPath = path.join("docs", "knowledge.json");
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(knowledge, null, 2), "utf8");
  console.log("Wrote:", outPath, "(", knowledge.docs.length, "docs )");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
