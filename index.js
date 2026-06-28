const fs = require('fs');

// Auto-load .env kalo belum di-set (biar bisa jalan tanpa --env-file)
if (!process.env.ZEN_API_KEY) {
  const envPath = `${__dirname}/.env`;
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const TRACKING_FILE = `${__dirname}/posted.json`;
const ZEN_API = 'https://opencode.ai/zen/v1/chat/completions';
const TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=ID';
const INTERVAL_MS = 30 * 60 * 1000;
const MAX_PER_CYCLE = 3;
const MAX_RETRIES = 2;

let running = false;
let wpFailCount = 0;
const WP_FAIL_LIMIT = 3;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadPosted() {
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch { return {}; }
}

function savePosted(p) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(p, null, 2));
}

async function tryFetch(url, opts, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function sanitizeErrorBody(text) {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/Basic\s+\S+/gi, 'Basic [REDACTED]');
}

async function throwIfNotOk(res, label) {
  if (res.ok) return;
  const text = await res.text();
  throw new Error(`${label} ${res.status}: ${sanitizeErrorBody(text.slice(0, 200))}`);
}

async function callZen(messages) {
  const res = await tryFetch(ZEN_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ZEN_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.ZEN_MODEL || 'deepseek-v4-flash',
      messages
    })
  });
  await throwIfNotOk(res, 'Zen API');
  const data = await res.json();
  return data.choices[0].message.content;
}

async function getTrends() {
  const res = await tryFetch(TRENDS_RSS);
  await throwIfNotOk(res, 'Trends RSS');
  const xml = await res.text();

  // ponytail: parse RSS <item> blocks, no xml lib needed
  const trends = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleM = item.match(/<title>(.+?)<\/title>/);
    const trafficM = item.match(/<ht:approx_traffic>(.+?)<\/ht:approx_traffic>/);
    if (titleM) trends.push({ topic: titleM[1].trim(), traffic: trafficM ? trafficM[1].trim() : '' });
  }
  return trends;
}

const TECH_KEYWORDS = [
  'ai','kecerdasan buatan','chatgpt','openai','gpt','machine learning','deep learning','llm',
  'crypto','bitcoin','blockchain','nft','web3','metaverse',
  'iphone','samsung','google','apple','microsoft','android','ios',
  'software','aplikasi','platform','digital','coding','programming','pemrograman',
  'cyber','keamanan','data','cloud','server',
  'robot','otomatis','automation','iot','chip','processor','cpu','gpu','hardware',
  'startup','tech','teknologi','windows','linux','macos',
  'elon musk','mark zuckerberg','tiktok','instagram','twitter','meta','facebook',
  'internet','website','game','gaming','playstation','xbox',
  'baterai','ev','mobil listrik','5g','6g','wifi','bluetooth',
  'browser','chrome','firefox','api','sdk','framework'
];

function isTechTopic(topic) {
  const lower = topic.toLowerCase();
  return TECH_KEYWORDS.some(kw => lower.includes(kw));
}

async function analyzeIntent(topic) {
  const prompt = `Analisa search intent topik trending: "${topic}"

Respon HANYA JSON. Contoh output:
{"informational":85,"commercial":10,"transactional":5,"navigational":0,"primary_intent":"informational","keywords":["kata kunci 1","kata kunci 2"],"category":"Teknologi","explanation":"penjelasan"}

Skor HARUS angka (0-100). category: pilih salah satu [Teknologi, Olahraga, Kesehatan, Politik, Ekonomi, Hiburan, Pendidikan, Lifestyle, Otomotif, Kuliner, Lainnya]`;

  const raw = await callZen([
    { role: 'system', content: 'Anda SEO analyst. Respon HANYA JSON. Skor HARUS angka (0-100). category HARUS salah satu dari daftar yang diberikan.' },
    { role: 'user', content: prompt }
  ]);

  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').replace(/```\s*$/gm, '').trim();
  const parsed = JSON.parse(cleaned);

  for (const key of ['informational', 'commercial', 'transactional', 'navigational']) {
    if (typeof parsed[key] === 'string') {
      const v = parsed[key].toLowerCase();
      if (['high', 'tinggi', 'very high', 'sangat tinggi'].includes(v)) parsed[key] = 90;
      else if (['medium', 'sedang', 'moderate'].includes(v)) parsed[key] = 50;
      else parsed[key] = parseInt(v) || 0;
    }
    parsed[key] = Math.min(100, Math.max(0, parseInt(parsed[key] || 0)));
  }

  if (!parsed.category) parsed.category = 'Lainnya';

  return parsed;
}

async function findProducts(topic, category) {
  const prompt = `Produk apa yang sedang tren dan relevan dengan topik "${topic}" (kategori: ${category})?

Respon HANYA JSON array. Contoh:
[{"name":"iPhone 17 Pro","description":"Smartphone terbaru Apple dengan chip A19","price":"Rp 18.000.000"}]

Beri 2-3 produk spesifik (merk + model). price: perkiraan harga pasar.`;

  const raw = await callZen([
    { role: 'system', content: 'Anda product researcher. Respon HANYA JSON array tanpa markdown.' },
    { role: 'user', content: prompt }
  ]);

  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').replace(/```\s*$/gm, '').trim();
  return JSON.parse(cleaned);
}

function shopeeAffiliateLink(productName) {
  const id = process.env.SHOPEE_AFFILIATE_ID || 'your_affiliate_id_here';
  const keyword = encodeURIComponent(productName);
  return `https://shopee.co.id/search?keyword=${keyword}&affiliateId=${id}`;
}

async function generateArticle(topic, keywords, intent, products) {
  const productHtml = (products || []).map(p =>
    `<p>🏷️ <strong>${p.name}</strong> — ${p.description} (${p.price || 'cek harga'}). <a href="${shopeeAffiliateLink(p.name)}" rel="nofollow sponsored" target="_blank">Cek harga terbaru di Shopee →</a></p>`
  ).join('\n');

  const productSection = productHtml
    ? `\n<h2>Produk Rekomendasi</h2>\n${productHtml}\n`
    : '';

  const prompt = `Buat artikel blog SEO Bahasa Indonesia tentang: "${topic}"

Keyword target: ${keywords.join(', ')}
Search intent: ${intent}

Struktur:
- Judul (h1)
- Pembuka 2-3 paragraf
- 3-4 sub-topik (h2 + paragraf)
- Natural selipkan rekomendasi produk yang relevan di sub-topik yang sesuai
- Kesimpulan
- FAQ (2 pertanyaan)
${productSection}
Minimal 500 kata. Format HTML langsung, tanpa markdown code block.`;

  const html = await callZen([
    { role: 'system', content: 'Anda content writer SEO Indonesia. Tulis langsung HTML, tanpa markdown.' },
    { role: 'user', content: prompt }
  ]);

  const productLinks = (products || []).map(p => ({
    name: p.name,
    find: new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
    link: `<a href="${shopeeAffiliateLink(p.name)}" rel="nofollow sponsored" target="_blank">${p.name}</a>`
  }));

  let enriched = html;
  for (const pl of productLinks) {
    enriched = enriched.replace(pl.find, pl.link);
  }

  return enriched;
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return m ? m[1].trim() : 'Trending Topic';
}

function extractContent(html) {
  const content = html.replace(/<h1[^>]*>.*?<\/h1>/i, '').trim();
  const adsense = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8206453332182814" crossorigin="anonymous"></script>';
  return `${content}\n\n${adsense}`;
}

async function postToWP(title, content) {
  const baseUrl = process.env.WP_URL.replace(/\/+$/, '');
  if (!baseUrl.startsWith('https://')) throw new Error('WP_URL harus menggunakan HTTPS');

  const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
  const url = `${baseUrl}/wp-json/wp/v2/posts`;

  const res = await tryFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, content, status: 'publish' })
  });

  await throwIfNotOk(res, 'WP API');
  return res.json();
}

async function cycle() {
  if (running) { log('Siklus sebelumnya masih berjalan, skip'); return; }
  running = true;

  if (wpFailCount >= WP_FAIL_LIMIT) {
    log(`WP gagal ${wpFailCount}x berturut-turut. Stop siklus.`);
    running = false;
    return;
  }

  log('=== Siklus baru ===');

  try {
    const posted = loadPosted();
    const trends = await getTrends();
    log(`Trending: ${trends.length} topik ditemukan`);

    // Urutkan: topik teknologi didahulukan
    trends.sort((a, b) => {
      const aIsTech = isTechTopic(a.topic) ? 0 : 1;
      const bIsTech = isTechTopic(b.topic) ? 0 : 1;
      return aIsTech - bIsTech;
    });

    let count = 0;

    for (const t of trends) {
      if (count >= MAX_PER_CYCLE) break;

      const topic = t.topic.normalize('NFC').toLowerCase().trim();
      if (!topic || posted[topic]) continue;

      log(`→ ${t.topic} (${t.traffic})`);
      await delay(1500);

      try {
        const intent = await analyzeIntent(t.topic);
        log(`  Intent: ${intent.primary_intent} | Kategori: ${intent.category} | Info: ${intent.informational}`);

        if (intent.informational >= 60) {
          const keywords = [t.topic, ...(intent.keywords || [])];

          let products = [];
          try {
            await delay(1500);
            products = await findProducts(t.topic, intent.category);
            log(`  Produk: ${products.map(p => p.name).join(', ')}`);
          } catch (err) {
            log(`  Produk: gagal (${err.message})`);
          }

          await delay(1500);
          const html = await generateArticle(t.topic, keywords, intent.primary_intent, products);
          const title = extractTitle(html);
          const content = extractContent(html);

          const result = await postToWP(title, content);
          log(`  ✓ POSTING: "${title}" [${intent.category}] (ID: ${result.id})`);
          wpFailCount = 0;

          posted[topic] = {
            postedAt: new Date().toISOString(),
            wpPostId: result.id,
            title,
            traffic: t.traffic,
            category: intent.category,
            intent: intent.primary_intent,
            products: products.map(p => p.name)
          };
          count++;
        } else {
          log(`  ✗ Skip (informational ${intent.informational} < 60)`);
        }
      } catch (err) {
        log(`  ✗ Error: ${err.message}`);
        if (err.message.startsWith('WP')) wpFailCount++;
      }
    }

    savePosted(posted);
    log(`Selesai: ${count} artikel baru`);
  } catch (err) {
    log(`FATAL: ${err.message}`);
  }

  running = false;
}

log('Auto Blogger 24/7 started');
log(`Interval: ${INTERVAL_MS / 60000} menit, Model: ${process.env.ZEN_MODEL || 'deepseek-v4-flash'}`);
cycle();
setInterval(cycle, INTERVAL_MS);
