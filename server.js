// Backend pembuka safelink: menjalankan halaman di browser tanpa tampilan,
// menunggu hitung mundur, menekan tombol lanjut, dan mengembalikan tujuan akhir.
// Tidak menyelesaikan captcha. Jika captcha muncul, hasilnya "captcha".
//
// Jalankan:  npm i playwright && npx playwright install --with-deps chromium
//            ALLOWED_ORIGIN=https://domainmu.com node server.js

const http = require("http");
const dns = require("dns").promises;
const net = require("net");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_MS = 45000;
const MAX_JOBS = 2;
const FILE_HOSTS = ["mediafire.com","sfile.mobi","sfile.co","drive.google.com","mega.nz","github.com","gofile.io","pixeldrain.com","dropbox.com","1drv.ms","terabox.com","files.fm","apkadmin.com","krakenfiles.com","workupload.com","devuploads.com"];
const BUTTONS = /get link|continue|lanjut|download|unduh|unlock|lihat link|go to link|skip|verify|i am a human/i;

let browser, jobs = 0;
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const isFile = u => { const h = hostOf(u); return FILE_HOSTS.some(f => h === f || h.endsWith("." + f)); };

function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const okCache = new Map();
async function publicHost(h) {
  if (okCache.has(h)) return okCache.get(h);
  let ok = false;
  try { ok = (await dns.lookup(h, { all: true })).every(r => !isPrivate(r.address)); } catch {}
  okCache.set(h, ok);
  return ok;
}

async function resolveLink(link) {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" });
  const start = hostOf(link), found = new Set();
  let note = "";
  try {
    // Blokir jaringan internal dan sumber daya berat
    await ctx.route("**/*", async route => {
      const req = route.request();
      if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
      if (!(await publicHost(hostOf(req.url())))) return route.abort();
      route.continue();
    });
    const page = await ctx.newPage();
    ctx.on("page", p => { if (p !== page) p.close().catch(() => {}); }); // tutup pop-up
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });

    const t0 = Date.now();
    while (Date.now() - t0 < MAX_MS) {
      const url = page.url();
      if (isFile(url)) { found.add(url); break; }
      if (hostOf(url) !== start && !isFile(url)) { await page.goBack().catch(() => {}); } // iklan: kembali

      const hrefs = await page.$$eval("a[href]", as => as.map(a => a.href)).catch(() => []);
      hrefs.filter(isFile).forEach(h => found.add(h));
      if (found.size) break;

      const captcha = await page.$('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile');
      if (captcha) { note = "captcha"; break; }

      for (const b of await page.$$("button, a, input[type=button]")) {
        const txt = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || "").trim();
        if (txt && BUTTONS.test(txt) && (await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => true))) {
          await b.click({ timeout: 2000 }).catch(() => {});
          break;
        }
      }
      await page.waitForTimeout(1000);
    }
    if (!found.size && !note) note = "tidak-ditemukan";
  } finally { await ctx.close().catch(() => {}); }
  return { urls: [...found], note };
}

http.createServer(async (req, res) => {
  const h = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Content-Type": "application/json" };
  const send = (c, o) => { res.writeHead(c, h); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/resolve") return send(404, { error: "not found" });
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN !== "*" && origin && origin !== ALLOWED_ORIGIN) return send(403, { error: "origin" });
  const link = u.searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(link) || !(await publicHost(hostOf(link)))) return send(400, { error: "url tidak valid" });
  if (jobs >= MAX_JOBS) return send(429, { error: "sibuk, coba lagi" });
  jobs++;
  try { send(200, await resolveLink(link)); }
  catch (e) { send(500, { error: String(e.message || e).slice(0, 200) }); }
  finally { jobs--; }
}).listen(PORT, async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  console.log("Backend siap di port " + PORT);
});
