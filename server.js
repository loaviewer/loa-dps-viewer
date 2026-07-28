// server.js
// 로스트아크 API 프록시 서버
// - 클라이언트(사이트)는 이 서버에만 요청을 보내고,
// - 이 서버가 대신 로스트아크 공식 API에 키를 붙여서 호출한 뒤 결과를 돌려줌
// - API 키는 절대 이 파일에 직접 쓰지 않고, 클라우드타입 "환경변수"에만 저장함

const express = require("express");
const cors = require("cors");
const app = express();

const API_KEYS = (process.env.LOSTARK_API_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const LOSTARK_BASE_URL = "https://developer-lostark.game.onstove.com";

let keyIndex = 0;
function getNextApiKey() {
  if (API_KEYS.length === 0) return null;
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

const ALLOWED_ORIGINS = [
  "https://loaviewer.github.io",
  // 로컬 테스트 중이면 아래처럼 본인 로컬 주소를 추가하세요
  // "http://127.0.0.1:5500",
  // "http://localhost:5500",
];

app.use(cors({ origin: ALLOWED_ORIGINS }));

app.get("/", (req, res) => {
  res.send("LOA proxy server is running");
});

// ===== 공통 함수 (단순 패스스루 호출용) =====
async function callLostArk(path, res) {
  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }
  try {
    const response = await fetch(`${LOSTARK_BASE_URL}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${currentKey}`,
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("로스트아크 API 호출 실패:", err.message);
    res.status(502).json({ error: "로스트아크 API 호출 중 오류가 발생했습니다." });
  }
}

// 거래소(/markets/items) 페이지네이션 전체 순회
async function fetchMarketPages(categoryCode, apiKey) {
  const baseBody = {
    Sort: "CURRENT_MIN_PRICE",
    CategoryCode: categoryCode,
    ItemTier: null,
    ItemGrade: "",
    ItemName: "",
    SortCondition: "ASC",
  };

  const firstRes = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...baseBody, PageNo: 1 }),
  });

  const firstData = await firstRes.json();
  if (!firstRes.ok) return [];

  const allItems = Array.isArray(firstData.Items) ? [...firstData.Items] : [];
  const totalPages = Math.ceil((firstData.TotalCount || 0) / (firstData.PageSize || 10));

  console.log(`[market] 카테고리 ${categoryCode} : 총 ${firstData.TotalCount}개, ${totalPages}페이지`);

  for (let page = 2; page <= totalPages; page++) {
    const pageRes = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...baseBody, PageNo: page }),
    });
    const pageData = await pageRes.json();
    if (pageRes.ok && Array.isArray(pageData.Items)) {
      allItems.push(...pageData.Items);
    }
  }

  return allItems;
}

// =================================================================
// ===== 캐릭터 조회 (프로필+장비+각인+카드+아크패시브+아크그리드 통합) =====
// =================================================================
// 같은 캐릭터를 짧은 시간 안에 여러 번 검색해도 로스트아크를 다시
// 안 부르도록 이름별로 짧게(60초) 캐시합니다. 폴링이 아니라 "검색"
// 이라서 시세처럼 워처를 돌릴 필요는 없고, 단순 TTL 캐시면 충분합니다.
const CHARACTER_CACHE_TTL = 60 * 1000; // 60초
const characterCache = new Map(); // key: 캐릭터명(소문자), value: { data, timestamp }

app.get("/character/:name/all", async (req, res) => {
  const rawName = req.params.name;
  const cacheKey = rawName.trim().toLowerCase();
  const now = Date.now();

  const cached = characterCache.get(cacheKey);
  if (cached && now - cached.timestamp < CHARACTER_CACHE_TTL) {
    return res.json({ ...cached.data, Cached: true });
  }

  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }

  try {
    const encoded = encodeURIComponent(rawName);
    const response = await fetch(`${LOSTARK_BASE_URL}/armories/characters/${encoded}`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${currentKey}`,
      },
    });
    const data = await response.json();

    if (response.ok) {
      characterCache.set(cacheKey, { data, timestamp: now });
    }
    res.status(response.status).json({ ...data, Cached: false });
  } catch (err) {
    console.error("캐릭터 통합 조회 실패:", err.message);
    res.status(502).json({ error: "캐릭터 정보를 불러오는 중 오류가 발생했습니다." });
  }
});

// 오래된 캐릭터 캐시는 10분마다 청소 (메모리 계속 쌓이는 것 방지)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of characterCache.entries()) {
    if (now - entry.timestamp > CHARACTER_CACHE_TTL * 5) {
      characterCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// ===== 기존 캐릭터 라우트 (하위 호환용으로 유지, 신규 개발은 /all 사용 권장) =====
app.get("/character/:name", (req, res) => {
  const name = encodeURIComponent(req.params.name);
  callLostArk(`/armories/characters/${name}/profiles`, res);
});

app.get("/character/:name/arkpassive", (req, res) => {
  const name = encodeURIComponent(req.params.name);
  callLostArk(`/armories/characters/${name}/arkpassive`, res);
});

// ===== 기타 단순 패스스루 =====
app.get("/gamecontents/calendar", (req, res) => {
  callLostArk(`/gamecontents/calendar`, res);
});
app.get("/news/events", (req, res) => {
  callLostArk(`/news/events`, res);
});
app.get("/news/notices", (req, res) => {
  callLostArk(`/news/notices`, res);
});

// =================================================================
// ===== 시세/경매 캐시 매니저 =====
// - 갱신은 "누군가 그 탭을 보고 있을 때만" 발생 (10초간 요청 없으면 정지)
// - 각인서는 실시간 경매 특성상 다른 카테고리보다 짧은 주기로 갱신
// =================================================================
const IDLE_LIMIT_MS = 10000; // 10초 동안 요청 없으면 "아무도 없음"으로 판단

const CACHE = {
  enhance:           { data: null, updatedAt: null, intervalMs: 15000, lastRequestedAt: 0 }, // 강화 재료
  engravings:        { data: null, updatedAt: null, intervalMs: 10000, lastRequestedAt: 0 }, // 각인서 시세 (거래소) - 빠르게
  auctionEngravings: { data: null, updatedAt: null, intervalMs: 10000, lastRequestedAt: 0 }, // 각인서 경매계산기용 (경매장) - 빠르게
  gems:              { data: null, updatedAt: null, intervalMs: 8000,  lastRequestedAt: 0 }, // 보석 (경매장, 호출 8회라 너무 짧게는 X)
  life:              { data: null, updatedAt: null, intervalMs: 25000, lastRequestedAt: 0 }, // 생활 재료
};

async function refreshEnhanceCache() {
  const key = getNextApiKey();
  if (!key) return;
  try {
    const [refineItems, supportItems] = await Promise.all([
      fetchMarketPages(50010, key),
      fetchMarketPages(50020, key),
    ]);
    const items = [...refineItems, ...supportItems];
    CACHE.enhance.data = { TotalCount: items.length, Items: items };
    CACHE.enhance.updatedAt = Date.now();
  } catch (err) {
    console.error("[cache] enhance 갱신 실패:", err.message);
  }
}

async function refreshEngravingsCache() {
  const key = getNextApiKey();
  if (!key) return;
  try {
    const items = await fetchMarketPages(40000, key);
    CACHE.engravings.data = { TotalCount: items.length, Items: items };
    CACHE.engravings.updatedAt = Date.now();
  } catch (err) {
    console.error("[cache] engravings 갱신 실패:", err.message);
  }
}

async function refreshLifeCache() {
  const key = getNextApiKey();
  if (!key) return;
  try {
    const items = await fetchMarketPages(90000, key);
    CACHE.life.data = { TotalCount: items.length, Items: items };
    CACHE.life.updatedAt = Date.now();
  } catch (err) {
    console.error("[cache] life 갱신 실패:", err.message);
  }
}

async function refreshGemsCache() {
  const key = getNextApiKey();
  if (!key) return;
  try {
    const gemNames = [
      "10레벨 겁화의 보석", "9레벨 겁화의 보석", "8레벨 겁화의 보석", "7레벨 겁화의 보석",
      "10레벨 작열의 보석", "9레벨 작열의 보석", "8레벨 작열의 보석", "7레벨 작열의 보석",
    ];
    const allItems = [];
    for (const gemName of gemNames) {
      const gemRes = await fetch(`${LOSTARK_BASE_URL}/auctions/items`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `bearer ${key}`,
        },
        body: JSON.stringify({
          Sort: "BUY_PRICE",
          CategoryCode: 210000,
          ItemTier: 4,
          ItemName: gemName,
          PageNo: 1,
          SortCondition: "ASC",
        }),
      });
      const gemData = await gemRes.json();
      if (gemRes.ok && gemData.Items?.length > 0) {
        const first = gemData.Items[0];
        allItems.push({
          Name: first.Name || gemName,
          Icon: first.Icon || "",
          Grade: first.Grade || "영웅",
          BundleCount: 1,
          CurrentMinPrice: first.AuctionInfo?.BuyPrice || first.AuctionInfo?.StartPrice || 0,
          RecentPrice: first.AuctionInfo?.BuyPrice || 0,
          YDayAvgPrice: first.AuctionInfo?.BuyPrice || 0,
          EndDate: first.AuctionInfo?.EndDate || null,
        });
      }
    }
    CACHE.gems.data = { TotalCount: allItems.length, Items: allItems };
    CACHE.gems.updatedAt = Date.now();
  } catch (err) {
    console.error("[cache] gems 갱신 실패:", err.message);
  }
}

// 경매 계산기용 - 유물 각인서만, 경매장(/auctions/items) 기준
async function refreshAuctionEngravingsCache() {
  const key = getNextApiKey();
  if (!key) return;
  try {
    const baseBody = {
      Sort: "CURRENT_MIN_PRICE",
      CategoryCode: 40000,
      CharacterClass: null,
      ItemTier: null,
      ItemGrade: "유물",
      ItemName: "",
      SortCondition: "ASC",
    };

    const firstResponse = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${key}`,
      },
      body: JSON.stringify({ ...baseBody, PageNo: 1 }),
    });
    const firstData = await firstResponse.json();
    if (!firstResponse.ok) return;

    const allItems = Array.isArray(firstData.Items) ? [...firstData.Items] : [];
    const totalPages = Math.ceil((firstData.TotalCount || 0) / (firstData.PageSize || 10));

    for (let page = 2; page <= totalPages; page++) {
      const pageResponse = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `bearer ${key}`,
        },
        body: JSON.stringify({ ...baseBody, PageNo: page }),
      });
      const pageData = await pageResponse.json();
      if (pageResponse.ok && Array.isArray(pageData.Items)) {
        allItems.push(...pageData.Items);
      }
    }

    CACHE.auctionEngravings.data = {
      PageNo: 1,
      PageSize: allItems.length,
      TotalCount: allItems.length,
      Items: allItems,
    };
    CACHE.auctionEngravings.updatedAt = Date.now();
  } catch (err) {
    console.error("[cache] auctionEngravings 갱신 실패:", err.message);
  }
}

const REFRESHERS = {
  enhance: refreshEnhanceCache,
  engravings: refreshEngravingsCache,
  auctionEngravings: refreshAuctionEngravingsCache,
  gems: refreshGemsCache,
  life: refreshLifeCache,
};

// ===== 워처: 1초마다 "체크"만 하고, 조건 맞을 때만 실제 호출 =====
Object.keys(CACHE).forEach((name) => {
  setInterval(async () => {
    const entry = CACHE[name];
    const now = Date.now();

    const someoneIsHere = now - entry.lastRequestedAt < IDLE_LIMIT_MS;
    if (!someoneIsHere) return; // 아무도 안 보고 있음 -> 호출 자체를 안 함

    const dueForRefresh = !entry.updatedAt || now - entry.updatedAt >= entry.intervalMs;
    if (!dueForRefresh) return; // 사람은 있지만 아직 주기가 안 됨

    await REFRESHERS[name]();
  }, 1000);
});

// ===== 캐시 반환 라우트 =====
function sendCache(name, res) {
  const entry = CACHE[name];
  entry.lastRequestedAt = Date.now(); // 이 요청 자체가 "사람이 있다"는 신호

  if (!entry.data) {
    return res.status(202).json({ ready: false, message: "데이터 준비 중입니다." });
  }
  res.json({ ready: true, UpdatedAt: entry.updatedAt, ...entry.data });
}

app.get("/markets/enhance", (req, res) => sendCache("enhance", res));
app.get("/markets/engravings", (req, res) => sendCache("engravings", res));
app.get("/markets/gems", (req, res) => sendCache("gems", res));
app.get("/markets/life", (req, res) => sendCache("life", res));

// 경매 계산기(유물 각인서) 전용 - 기존 프론트 경로 유지
app.get("/auctions/items", (req, res) => sendCache("auctionEngravings", res));

// ===== 서버 시작 =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
