// 스킬코드 중계 라우트 (Express). 서버 메인 파일에서:  require("./skillcode-route")(app);
// 필요: Node 18 이상 (내장 fetch)
const BASE = "https://lostark.game.onstove.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const cache = new Map();          // 이름 -> { t, code }
const TTL = 5 * 60 * 1000;
let lastCall = 0;                 // 공식 사이트에 너무 빠르게 연속 요청하지 않도록 최소 간격
const MIN_GAP = 400;

function pick(html, key) {
  const m = html.match(new RegExp("var\\s+" + key + "\\s*=\\s*'([^']*)'"));
  return m ? m[1] : null;
}
function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

async function fetchSkillCode(name) {
  const wait = lastCall + MIN_GAP - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const pageUrl = BASE + "/Profile/Character/" + encodeURIComponent(name);
  const page = await fetch(pageUrl, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
  if (!page.ok) throw new Error("profile " + page.status);
  const html = await page.text();
  const memberNo = pick(html, "_memberNo"), pcId = pick(html, "_pcId"), worldNo = pick(html, "_worldNo");
  if (!memberNo || !pcId || !worldNo) throw new Error("ids not found");

  const r = await fetch(BASE + "/Profile/SkillRecommend", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": BASE,
      "Referer": pageUrl,
      "Accept": "*/*",
      "Cookie": cookiesOf(page),
    },
    body: new URLSearchParams({ memberNo, worldNo, pcId }).toString(),
  });
  if (!r.ok) throw new Error("skillcode " + r.status);
  const j = await r.json();
  const m = String(j.content || "").match(/class=["']code["']>\s*([0-9A-Fa-f]{32,})\s*</);
  if (!m) throw new Error("code not found");
  return m[1].toUpperCase();
}

module.exports = function (app) {
  app.get("/character/:name/skillcode", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const name = String(req.params.name || "").trim();
    if (!name || name.length > 20) return res.status(400).json({ ok: false, error: "bad name" });
    const hit = cache.get(name);
    if (hit && Date.now() - hit.t < TTL) return res.json({ ok: true, code: hit.code, cached: true });
    try {
      const code = await fetchSkillCode(name);
      cache.set(name, { t: Date.now(), code });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      res.json({ ok: true, code });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });
};
module.exports.fetchSkillCode = fetchSkillCode;
