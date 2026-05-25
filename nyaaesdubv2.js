const DEFAULT_BASE_URL = "https://nyaa.si";
const BASE_REQUIRED = ["dub", "dual audio", "multi audio", "multi-audio", "spanish dub", "audio latino", "latino", "castellano", "espanol", "español"];
const BASE_REJECT = ["raw", "sub only", "subs only", "softsub", "spanish sub", "sub espanol", "sub español"];

function normalizeText(value = "") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(arr) {
  return [...new Set(arr)];
}

function splitCsv(value, fallback = []) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.split(",").map(v => normalizeText(v)).filter(Boolean);
}

function escapeRegex(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSizeToBytes(value = "") {
  const m = value.match(/([\d.]+)\s*(KiB|MiB|GiB|TiB)/i);
  if (!m) return 0;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  const map = {
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  };
  return Math.round(num * (map[unit] || 1));
}

function parseKeywords(options, query) {
  const required = unique([...BASE_REQUIRED, ...splitCsv(options.requiredKeywords)]);
  const reject = unique([...BASE_REJECT, ...splitCsv(options.rejectKeywords), ...((query.exclusions || []).map(normalizeText))]);
  return { required, reject };
}

function getPreferredTerms(preferredSpanish = "latino") {
  const pref = normalizeText(preferredSpanish || "latino");
  if (pref === "castellano") {
    return {
      preferred: ["castellano", "spanish castellano", "espanol castellano", "audio castellano"],
      secondary: ["latino", "audio latino", "spanish dub", "espanol latino"]
    };
  }
  if (pref === "any") {
    return {
      preferred: ["latino", "audio latino", "castellano", "spanish dub", "espanol", "español"],
      secondary: []
    };
  }
  return {
    preferred: ["latino", "audio latino", "espanol latino", "spanish dub"],
    secondary: ["castellano", "audio castellano"]
  };
}

function buildSearchTerms(query, preferredSpanish = "latino") {
  const titles = (query.titles || []).filter(Boolean);
  const episode = Number(query.episode || 0);
  const abs = Number(query.absoluteEpisodeNumber || 0);
  const pref = normalizeText(preferredSpanish);
  const langHint = pref === "castellano" ? "castellano" : pref === "any" ? "spanish" : "latino";

  const out = [];
  for (const title of titles.slice(0, 5)) {
    out.push(`${title} ${langHint} ${episode}`.trim());
    out.push(`${title} ${langHint}`.trim());
    out.push(`${title} spanish dub ${episode}`.trim());
    out.push(`${title} spanish dub`.trim());
    out.push(`${title} dual audio ${episode}`.trim());
    out.push(`${title} dual audio`.trim());
    out.push(`${title} ${episode}`.trim());
    out.push(title.trim());
    if (abs && abs !== episode) {
      out.push(`${title} ${langHint} ${abs}`.trim());
      out.push(`${title} ${abs}`.trim());
    }
  }
  return unique(out);
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml"
    }
  });
  if (!res.ok) throw new Error(`Nyaa devolvió ${res.status} al consultar ${url}`);
  return await res.text();
}

function extractHashFromMagnet(link = "") {
  const match = link.match(/xt=urn:btih:([A-Za-z0-9]+)/i);
  return match ? match[1].toUpperCase() : "";
}

function extractRows(html, baseUrl) {
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;

  while ((tr = trRegex.exec(html)) !== null) {
    const row = tr[1];

    const categoryMatch = row.match(/<a[^>]+href="\/\?c=([^"&]+)[^"]*"/i);
    const titleMatch =
      row.match(/<a[^>]+href="(\/view\/\d+)"[^>]+title="([^"]+)"[^>]*>/i) ||
      row.match(/<a[^>]+href="(\/view\/\d+)"[^>]*>([^<]+)<\/a>/i);

    if (!titleMatch) continue;

    const pageUrl = new URL(titleMatch[1], baseUrl).toString();
    const title = (titleMatch[2] || "")
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .trim();

    const magnetMatch = row.match(/href="(magnet:\?[^"]+)"/i);
    const torrentMatch = row.match(/href="(\/download\/\d+\.torrent)"/i);
    const sizeMatch = row.match(/<td class="text-center">([\d.]+\s(?:KiB|MiB|GiB|TiB))<\/td>/i);
    const timeMatch = row.match(/data-timestamp="(\d+)"/i);

    const cells = [...row.matchAll(/<td class="text-center"[^>]*>(.*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
    const numericCells = cells.filter(v => /^-?\d+$/.test(v)).map(Number);

    const seeders = numericCells.length >= 3 ? numericCells[numericCells.length - 3] : 0;
    const leechers = numericCells.length >= 2 ? numericCells[numericCells.length - 2] : 0;
    const downloads = numericCells.length >= 1 ? numericCells[numericCells.length - 1] : 0;

    rows.push({
      category: categoryMatch ? categoryMatch[1] : "",
      title,
      pageUrl,
      link: magnetMatch
        ? magnetMatch[1].replace(/&amp;/g, "&")
        : torrentMatch
          ? new URL(torrentMatch[1], baseUrl).toString()
          : pageUrl,
      hash: magnetMatch ? extractHashFromMagnet(magnetMatch[1].replace(/&amp;/g, "&")) : "",
      sizeText: sizeMatch ? sizeMatch[1] : "0 B",
      size: parseSizeToBytes(sizeMatch ? sizeMatch[1] : "0 B"),
      timestamp: timeMatch ? Number(timeMatch[1]) * 1000 : Date.now(),
      seeders,
      leechers,
      downloads
    });
  }

  return rows;
}

function titleContainsAny(normalizedTitle, list) {
  return list.some(term => normalizedTitle.includes(normalizeText(term)));
}

function countTitleWordHits(normalizedTitle, titles) {
  let best = 0;
  for (const t of titles) {
    const nt = normalizeText(t);
    if (!nt) continue;
    const words = nt.split(" ").filter(Boolean);
    const hits = words.filter(w => normalizedTitle.includes(w)).length;
    if (hits > best) best = hits;
  }
  return best;
}

function episodePatterns(query) {
  const ep = Number(query.episode || 0);
  const abs = Number(query.absoluteEpisodeNumber || 0);
  const set = new Set();

  if (ep) {
    set.add(new RegExp(`(^|\\s)${ep}(\\s|$)`));
    set.add(new RegExp(`\\be${ep}\\b`, "i"));
    set.add(new RegExp(`\\bep(?:isode)?\\s*${ep}\\b`, "i"));
    set.add(new RegExp(`\\b0*${ep}\\b`, "i"));
  }

  if (abs && abs !== ep) {
    set.add(new RegExp(`(^|\\s)${abs}(\\s|$)`));
    set.add(new RegExp(`\\be${abs}\\b`, "i"));
  }

  return [...set];
}

function isBatchTitle(normalizedTitle) {
  return /\bbatch\b|\bcomplete\b|\btemporada\b|\bseason\b|\b全集\b|\b1-12\b|\b1 12\b|\b01-12\b|\b01 12\b/.test(normalizedTitle);
}

function scoreRow(row, query, options, requiredKeywords, rejectKeywords) {
  const normalizedTitle = normalizeText(row.title);
  const titles = (query.titles || []).filter(Boolean);
  const pref = getPreferredTerms(options.preferredSpanish || "latino");
  const patterns = episodePatterns(query);

  if (rejectKeywords.some(k => normalizedTitle.includes(k))) return -9999;

  let score = 0;

  const wordHits = countTitleWordHits(normalizedTitle, titles);
  score += wordHits * 12;

  const exactTitle = titles.some(t => normalizedTitle.includes(normalizeText(t)));
  if (exactTitle) score += 40;

  const requiredHits = requiredKeywords.filter(k => normalizedTitle.includes(k)).length;
  score += requiredHits * 10;

  if (titleContainsAny(normalizedTitle, pref.preferred)) score += 35;
  if (titleContainsAny(normalizedTitle, pref.secondary)) score += 8;

  if (/\bdual audio\b/.test(normalizedTitle)) score += 12;
  if (/\bmulti audio\b|\bmulti-audio\b/.test(normalizedTitle)) score += 10;

  const episodeMatch = patterns.some(rx => rx.test(normalizedTitle));
  if (episodeMatch) score += 35;

  const batch = isBatchTitle(normalizedTitle);
  if (batch) score += 6;

  if (query.resolution) {
    if (normalizedTitle.includes(query.resolution)) score += 8;
    else score -= 2;
  }

  score += Math.min(row.seeders, 50) * 0.6;
  score += Math.min(row.downloads, 200) * 0.05;

  if (row.category === "1_2") score += 4;
  if (row.category === "1_4") score += 2;

  if (!row.hash && String(row.link).startsWith("magnet:")) score -= 30;

  return score;
}

async function hydrateHashIfNeeded(result, fetchImpl) {
  if (result.hash) return result;
  if (!result.pageUrl) return result;

  try {
    const html = await fetchText(result.pageUrl, fetchImpl);
    const hashFromPage =
      (html.match(/infohash[^A-Fa-f0-9]{0,40}([A-Fa-f0-9]{40})/i) || [])[1] ||
      (html.match(/\b([A-Fa-f0-9]{40})\b/) || [])[1];

    if (hashFromPage) {
      result.hash = hashFromPage.toUpperCase();
      if (!String(result.link).startsWith("magnet:")) {
        result.link = `magnet:?xt=urn:btih:${result.hash}`;
      }
    }
  } catch (_) {}

  return result;
}

async function runSearch(query, options = {}, mode = "single") {
  const fetchImpl = query.fetch || globalThis.fetch;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const category = options.category || "0_0";
  const preferredSpanish = options.preferredSpanish || "latino";
  const maxResults = Math.max(1, Number(options.maxResults || 20));
  const { required, reject } = parseKeywords(options, query);
  const terms = buildSearchTerms(query, preferredSpanish);

  const seen = new Set();
  let candidates = [];

  for (const term of terms.slice(0, 8)) {
    const url = `${baseUrl}/?f=0&c=${encodeURIComponent(category)}&q=${encodeURIComponent(term)}&s=seeders&o=desc`;
    const html = await fetchText(url, fetchImpl);
    const rows = extractRows(html, baseUrl);

    for (const row of rows) {
      const key = row.pageUrl || row.link;
      if (seen.has(key)) continue;
      seen.add(key);

      const score = scoreRow(row, query, options, required, reject);
      if (score > 0) {
        candidates.push({ ...row, score });
      }
    }
  }

  if (mode === "batch") {
    candidates = candidates.filter(item => isBatchTitle(normalizeText(item.title)));
  } else if (mode === "single") {
    candidates = candidates.filter(item => !isBatchTitle(normalizeText(item.title)) || item.score >= 80);
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    b.seeders - a.seeders ||
    b.downloads - a.downloads ||
    b.timestamp - a.timestamp
  );

  const top = candidates.slice(0, maxResults);

  for (const item of top) {
    await hydrateHashIfNeeded(item, fetchImpl);
  }

  return top.map(item => ({
    title: item.title,
    link: item.link,
    id: undefined,
    seeders: item.seeders,
    leechers: item.leechers,
    downloads: item.downloads,
    accuracy: item.score >= 110 ? "medium" : "low",
    hash: item.hash || "",
    size: item.size,
    date: new Date(item.timestamp),
    type: isBatchTitle(normalizeText(item.title)) ? "batch" : undefined
  }));
}

export default {
  async test() {
    const html = await fetchText(`${DEFAULT_BASE_URL}/?f=0&c=0_0&q=latino&s=seeders&o=desc`, globalThis.fetch);
    if (!html.includes("Nyaa")) {
      throw new Error("Nyaa no respondió con el contenido esperado.");
    }
    return true;
  },

  async single(query, options = {}) {
    try {
      const results = await runSearch(query, options, "single");
      return results.length ? results : undefined;
    } catch (error) {
      throw new Error(error?.message || "Error buscando episodio doblado en Nyaa.");
    }
  },

  async batch(query, options = {}) {
    try {
      const results = await runSearch(query, options, "batch");
      return results.length ? results : undefined;
    } catch (error) {
      throw new Error(error?.message || "Error buscando batch doblado en Nyaa.");
    }
  },

  async movie(query, options = {}) {
    try {
      const results = await runSearch(query, options, "single");
      return results.length ? results : undefined;
    } catch (error) {
      throw new Error(error?.message || "Error buscando película doblada en Nyaa.");
    }
  }
};
