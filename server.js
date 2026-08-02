// server.js
// 로아 API 프록시 서버
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
   "http://127.0.0.1:5500",
    "http://localhost:5500",
];

app.use(cors({ origin: ALLOWED_ORIGINS }));

app.get("/", (req, res) => {
  res.send("LOA proxy server is running");
});

// ===== 공통 함수 =====
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

// 거래소 페이지네이션 전체 순회
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

  if (totalPages > 1) {
    const pagePromises = [];
    for (let page = 2; page <= totalPages; page++) {
      const pageApiKey = getNextApiKey() || apiKey;
      pagePromises.push(
        fetch(`${LOSTARK_BASE_URL}/markets/items`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `bearer ${pageApiKey}`,
          },
          body: JSON.stringify({ ...baseBody, PageNo: page }),
        }).then(async (res) => (res.ok ? (await res.json()).Items || [] : []))
      );
    }
    const pageResults = await Promise.all(pagePromises);
    pageResults.forEach((items) => allItems.push(...items));
  }

  return allItems;
}

// ===== 캐릭터 통합 조회 =====
const CHARACTER_CACHE_TTL = 60 * 1000;
const characterCache = new Map();

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

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of characterCache.entries()) {
    if (now - entry.timestamp > CHARACTER_CACHE_TTL * 5) {
      characterCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// 하위 호환
app.get("/character/:name", (req, res) => callLostArk(`/armories/characters/${encodeURIComponent(req.params.name)}/profiles`, res));
app.get("/character/:name/arkpassive", (req, res) => callLostArk(`/armories/characters/${encodeURIComponent(req.params.name)}/arkpassive`, res));
app.get("/gamecontents/calendar", (req, res) => callLostArk(`/gamecontents/calendar`, res));
app.get("/news/events", (req, res) => callLostArk(`/news/events`, res));
app.get("/news/notices", (req, res) => callLostArk(`/news/notices`, res));

// =================================================================
// ===== 시세/경매 캐시 매니저 (상태 제어 추가) =====
// =================================================================
const IDLE_LIMIT_MS = 10000;

const CACHE = {
  enhance:           { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 15000, lastRequestedAt: 0, isFetching: false },
  engravings:        { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 10000, lastRequestedAt: 0, isFetching: false },
  auctionEngravings: { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 10000, lastRequestedAt: 0, isFetching: false },
  gems:              { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 8000,  lastRequestedAt: 0, isFetching: false },
  life:              { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 25000, lastRequestedAt: 0, isFetching: false },
};

async function refreshEnhanceCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.enhance.apiStatus = "OFFLINE"; return; }
  try {
    const [refineItems, supportItems] = await Promise.all([
      fetchMarketPages(50010, key),
      fetchMarketPages(50020, key),
    ]);
    const items = [...refineItems, ...supportItems];
    if (items.length > 0) {
      CACHE.enhance.data = { TotalCount: items.length, Items: items };
      CACHE.enhance.updatedAt = Date.now();
      CACHE.enhance.lastSuccessAt = Date.now();
      CACHE.enhance.apiStatus = "ONLINE";
    } else {
      CACHE.enhance.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] enhance 갱신 실패:", err.message);
    CACHE.enhance.apiStatus = "OFFLINE";
  }
}

async function refreshEngravingsCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.engravings.apiStatus = "OFFLINE"; return; }
  try {
    const items = await fetchMarketPages(40000, key);
    if (items.length > 0) {
      CACHE.engravings.data = { TotalCount: items.length, Items: items };
      CACHE.engravings.updatedAt = Date.now();
      CACHE.engravings.lastSuccessAt = Date.now();
      CACHE.engravings.apiStatus = "ONLINE";
    } else {
      CACHE.engravings.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] engravings 갱신 실패:", err.message);
    CACHE.engravings.apiStatus = "OFFLINE";
  }
}

async function refreshLifeCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.life.apiStatus = "OFFLINE"; return; }
  try {
    const items = await fetchMarketPages(90000, key);
    if (items.length > 0) {
      CACHE.life.data = { TotalCount: items.length, Items: items };
      CACHE.life.updatedAt = Date.now();
      CACHE.life.lastSuccessAt = Date.now();
      CACHE.life.apiStatus = "ONLINE";
    } else {
      CACHE.life.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] life 갱신 실패:", err.message);
    CACHE.life.apiStatus = "OFFLINE";
  }
}

async function refreshGemsCache() {
  const gemNames = [
    "10레벨 겁화의 보석", "9레벨 겁화의 보석", "8레벨 겁화의 보석", "7레벨 겁화의 보석",
    "10레벨 작열의 보석", "9레벨 작열의 보석", "8레벨 작열의 보석", "7레벨 작열의 보석",
  ];
  try {
    const promises = gemNames.map((gemName) => {
      const key = getNextApiKey();
      return fetch(`${LOSTARK_BASE_URL}/auctions/items`, {
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
      }).then(async (res) => {
        if (!res.ok) return null;
        const gemData = await res.json();
        if (gemData.Items?.length > 0) {
          const first = gemData.Items[0];
          return {
            Name: first.Name || gemName,
            Icon: first.Icon || "",
            Grade: first.Grade || "영웅",
            BundleCount: 1,
            CurrentMinPrice: first.AuctionInfo?.BuyPrice || first.AuctionInfo?.StartPrice || 0,
            RecentPrice: first.AuctionInfo?.BuyPrice || 0,
            YDayAvgPrice: first.AuctionInfo?.BuyPrice || 0,
            EndDate: first.AuctionInfo?.EndDate || null,
          };
        }
        return null;
      });
    });

    const results = await Promise.all(promises);
    const allItems = results.filter(Boolean);

    if (allItems.length > 0) {
      CACHE.gems.data = { TotalCount: allItems.length, Items: allItems };
      CACHE.gems.updatedAt = Date.now();
      CACHE.gems.lastSuccessAt = Date.now();
      CACHE.gems.apiStatus = "ONLINE";
    } else {
      CACHE.gems.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] gems 갱신 실패:", err.message);
    CACHE.gems.apiStatus = "OFFLINE";
  }
}

async function refreshAuctionEngravingsCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.auctionEngravings.apiStatus = "OFFLINE"; return; }
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
    if (!firstResponse.ok) {
      CACHE.auctionEngravings.apiStatus = "OFFLINE";
      return;
    }

    const allItems = Array.isArray(firstData.Items) ? [...firstData.Items] : [];
    const totalPages = Math.ceil((firstData.TotalCount || 0) / (firstData.PageSize || 10));

    if (totalPages > 1) {
      const pagePromises = [];
      for (let page = 2; page <= totalPages; page++) {
        const pageKey = getNextApiKey() || key;
        pagePromises.push(
          fetch(`${LOSTARK_BASE_URL}/markets/items`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `bearer ${pageKey}`,
            },
            body: JSON.stringify({ ...baseBody, PageNo: page }),
          }).then(async (res) => (res.ok ? (await res.json()).Items || [] : []))
        );
      }
      const pageResults = await Promise.all(pagePromises);
      pageResults.forEach((items) => allItems.push(...items));
    }

    if (allItems.length > 0) {
      CACHE.auctionEngravings.data = {
        PageNo: 1,
        PageSize: allItems.length,
        TotalCount: allItems.length,
        Items: allItems,
      };
      CACHE.auctionEngravings.updatedAt = Date.now();
      CACHE.auctionEngravings.lastSuccessAt = Date.now();
      CACHE.auctionEngravings.apiStatus = "ONLINE";
    } else {
      CACHE.auctionEngravings.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] auctionEngravings 갱신 실패:", err.message);
    CACHE.auctionEngravings.apiStatus = "OFFLINE";
  }
}

const REFRESHERS = {
  enhance: refreshEnhanceCache,
  engravings: refreshEngravingsCache,
  auctionEngravings: refreshAuctionEngravingsCache,
  gems: refreshGemsCache,
  life: refreshLifeCache,
};

// 워밍업
async function warmUpCaches() {
  console.log("[cache] 서버 시작 - 캐시 워밍업 시작");
  for (const name of Object.keys(REFRESHERS)) {
    try {
      CACHE[name].isFetching = true;
      await REFRESHERS[name]();
      console.log(`[cache] ${name} 워밍업 완료`);
    } catch (err) {
      console.error(`[cache] ${name} 워밍업 실패:`, err.message);
    } finally {
      CACHE[name].isFetching = false;
    }
  }
  console.log("[cache] 캐시 워밍업 전체 완료");
}
warmUpCaches();

// 워처
Object.keys(CACHE).forEach((name) => {
  setInterval(async () => {
    const entry = CACHE[name];
    const now = Date.now();

    if (entry.isFetching) return;

    const someoneIsHere = now - entry.lastRequestedAt < IDLE_LIMIT_MS;
    if (!someoneIsHere) return;

    // 성공 여부와 무관하게 "마지막으로 시도한 시각" 기준으로 간격을 지킴
    // (계속 실패하는 상황에서도 intervalMs를 무시하고 매초 재시도하는 걸 방지)
    const dueForRefresh = !entry.lastAttemptAt || now - entry.lastAttemptAt >= entry.intervalMs;
    if (!dueForRefresh) return;

    try {
      entry.isFetching = true;
      entry.lastAttemptAt = now;
      await REFRESHERS[name]();
    } finally {
      entry.isFetching = false;
    }
  }, 1000);
});

// 캐시 반환 라우트 (점검 중이어도 캐시 데이터 보존 반환)
function sendCache(name, res) {
  const entry = CACHE[name];
  entry.lastRequestedAt = Date.now();

  const responseData = entry.data || { TotalCount: 0, Items: [] };

  res.json({ 
    ready: true, 
    apiStatus: entry.apiStatus,         // ONLINE / OFFLINE
    lastSuccessAt: entry.lastSuccessAt, // 마지막 성공 타임스탬프 (ms)
    UpdatedAt: entry.updatedAt, 
    ...responseData 
  });
}

app.get("/markets/enhance", (req, res) => sendCache("enhance", res));
app.get("/markets/engravings", (req, res) => sendCache("engravings", res));
app.get("/markets/gems", (req, res) => sendCache("gems", res));
app.get("/markets/life", (req, res) => sendCache("life", res));
app.get("/auctions/items", (req, res) => sendCache("auctionEngravings", res));

// 서버 시작
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
