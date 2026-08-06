// server.js
// 로아 API 프록시 서버
// - 클라이언트(사이트)는 이 서버에만 요청을 보내고,
// - 이 서버가 대신 로스트아크 공식 API에 키를 붙여서 호출한 뒤 결과를 돌려줌
// - API 키는 절대 이 파일에 직접 쓰지 않고, 클라우드타입 "환경변수"에만 저장함

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
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

// 2026년 8월 6일 추가: 배틀 아이템 등 새 탭을 만들기 전에 정확한 CategoryCode를 확인하기 위한 임시 디버그용 라우트.
// 배포 후 브라우저에서 이 주소로 들어가면 전체 카테고리 이름+코드 목록이 그대로 보입니다.
// (배틀 아이템 코드 확인 끝나면 이 라우트는 지워도 됩니다)
app.get("/debug/categories", async (req, res) => {
  const key = getNextApiKey();
  if (!key) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }
  try {
    const response = await fetch(`${LOSTARK_BASE_URL}/markets/options`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${key}`,
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "카테고리 조회 실패: " + err.message });
  }
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
  // 2026년 8월 6일 추가: 배틀 아이템(전투 용품) / 에스더의 기운
  battleItems:       { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 15000, lastRequestedAt: 0, isFetching: false },
  esther:            { data: null, updatedAt: null, lastSuccessAt: null, lastAttemptAt: null, apiStatus: "OFFLINE", intervalMs: 20000, lastRequestedAt: 0, isFetching: false },
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

      // 2026년 8월 6일 추가: 각인서 히스토리 그래프가 항상 0으로 뜨는 문제 디버깅용.
      // 유물 등급 각인서 1개를 골라서 원본 필드를 한 번 콘솔에 찍어봄.
      // (배포 로그에서 확인 후 필요 없으면 지워도 됩니다)
      const sampleRelic = items.find((it) => it.Grade === "유물");
      if (sampleRelic) {
        console.log("[debug] 유물 각인서 샘플 아이템:", {
          Id: sampleRelic.Id,
          Name: sampleRelic.Name,
          Grade: sampleRelic.Grade,
        });
      }
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

// =================================================================
// ===== 배틀 아이템(전투 용품) - 2026년 8월 6일 추가 =====
// 카테고리: 전투 용품(60000) 하위 4개 - 회복형/공격형/기능성/버프형
// =================================================================
const BATTLE_ITEM_SUBCATS = {
  60200: "heal",
  60300: "attack",
  60400: "utility",
  60500: "buff",
};

async function refreshBattleItemsCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.battleItems.apiStatus = "OFFLINE"; return; }
  try {
    const codes = Object.keys(BATTLE_ITEM_SUBCATS).map(Number);
    const results = await Promise.all(
      codes.map((code) =>
        fetchMarketPages(code, getNextApiKey() || key).then((items) =>
          items.map((it) => ({ ...it, SubCat: BATTLE_ITEM_SUBCATS[code] }))
        )
      )
    );
    const items = results.flat();
    if (items.length > 0) {
      CACHE.battleItems.data = { TotalCount: items.length, Items: items };
      CACHE.battleItems.updatedAt = Date.now();
      CACHE.battleItems.lastSuccessAt = Date.now();
      CACHE.battleItems.apiStatus = "ONLINE";
    } else {
      CACHE.battleItems.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] battleItems 갱신 실패:", err.message);
    CACHE.battleItems.apiStatus = "OFFLINE";
  }
}

// =================================================================
// ===== 에스더의 기운 - 2026년 8월 6일 추가 =====
// 등급이 "에스더"인 특수 아이템. 카테고리 트리에 별도 리프 코드가 없어서
// 이름 검색(ItemName) + 등급 필터(ItemGrade: "에스더")로 찾음.
// =================================================================
async function refreshEstherCache() {
  const key = getNextApiKey();
  if (!key) { CACHE.esther.apiStatus = "OFFLINE"; return; }
  try {
    const response = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${key}`,
      },
      body: JSON.stringify({
        Sort: "CURRENT_MIN_PRICE",
        CategoryCode: 0,
        ItemGrade: "에스더",
        ItemName: "에스더의 기운",
        PageNo: 1,
        SortCondition: "ASC",
      }),
    });

    if (!response.ok) {
      CACHE.esther.apiStatus = "OFFLINE";
      return;
    }

    const data = await response.json();
    const items = (data.Items || []).filter((it) => it.Grade === "에스더");

    if (items.length > 0) {
      CACHE.esther.data = { TotalCount: items.length, Items: items };
      CACHE.esther.updatedAt = Date.now();
      CACHE.esther.lastSuccessAt = Date.now();
      CACHE.esther.apiStatus = "ONLINE";
    } else {
      CACHE.esther.apiStatus = "OFFLINE";
    }
  } catch (err) {
    console.error("[cache] esther 갱신 실패:", err.message);
    CACHE.esther.apiStatus = "OFFLINE";
  }
}

// =================================================================
// ===== 보석 자체 히스토리 스냅샷 (2026년 8월 6일 추가) =====
// 공식 API는 경매장(보석) 아이템에 대해 "최근 N일 시세" 히스토리를 제공하지 않음.
// (거래소 아이템만 /markets/items/{id} 에서 Stats 히스토리를 줌)
// 그래서 이 서버가 보석 캐시를 갱신할 때마다(하루 1회분만 채택) 직접 스냅샷을
// 메모리에 쌓아서 "우리가 관찰한 최근 10일" 그래프를 만들어줌.
// 주의: 서버 프로세스가 재시작되면 지금까지 쌓인 히스토리는 초기화됨.
//       (영구 보관하려면 파일/DB에 저장하도록 확장 필요)
// =================================================================
const GEM_NAMES = [
  "10레벨 겁화의 보석", "9레벨 겁화의 보석", "8레벨 겁화의 보석", "7레벨 겁화의 보석",
  "10레벨 작열의 보석", "9레벨 작열의 보석", "8레벨 작열의 보석", "7레벨 작열의 보석",
];

const GEM_HISTORY = new Map(); // gemName -> [{date, avgPrice, tradeCount}, ...] (최대 10개, 오래된순)
const GEM_HISTORY_MAX_DAYS = 10;

// 2026년 8월 6일 추가: 재배포/재시작해도 최근까지 쌓은 기록이 날아가지 않도록 디스크에도 저장.
// 주의: 클라우드타입이 "완전 새 컨테이너로 재배포"하는 방식이면 이 파일도 초기화될 수 있음.
// (재시작/크래시 복구 수준에서는 안전하게 유지됨)
const GEM_HISTORY_FILE = path.join(__dirname, "gem_history.json");

function loadGemHistoryFromDisk() {
  try {
    if (fs.existsSync(GEM_HISTORY_FILE)) {
      const raw = fs.readFileSync(GEM_HISTORY_FILE, "utf-8");
      const obj = JSON.parse(raw);
      Object.keys(obj).forEach((gemName) => {
        GEM_HISTORY.set(gemName, obj[gemName]);
      });
      console.log("[gem-history] 디스크에서 기존 히스토리 불러옴:", Object.keys(obj).length, "개 보석");
    }
  } catch (err) {
    console.error("[gem-history] 디스크 로드 실패 (무시하고 새로 시작함):", err.message);
  }
}

function saveGemHistoryToDisk() {
  try {
    const obj = {};
    GEM_HISTORY.forEach((history, gemName) => {
      obj[gemName] = history;
    });
    fs.writeFileSync(GEM_HISTORY_FILE, JSON.stringify(obj), "utf-8");
  } catch (err) {
    console.error("[gem-history] 디스크 저장 실패:", err.message);
  }
}

loadGemHistoryFromDisk();

function getKstDateString(date = new Date()) {
  // 서버가 어느 시간대에서 돌든 한국 날짜 기준(YYYY-MM-DD)으로 하루를 구분하기 위함
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function recordGemSnapshot(gemName, price, listingCount) {
  const today = getKstDateString();
  let history = GEM_HISTORY.get(gemName);
  if (!history) {
    history = [];
    GEM_HISTORY.set(gemName, history);
  }

  const last = history[history.length - 1];
  if (last && last.date === today) {
    // 같은 날 여러 번 갱신되면, 그날의 "가장 최근 관측값"으로 덮어씀
    last.avgPrice = price;
    last.tradeCount = listingCount;
  } else {
    history.push({ date: today, avgPrice: price, tradeCount: listingCount });
    if (history.length > GEM_HISTORY_MAX_DAYS) {
      history.shift();
    }
  }

  saveGemHistoryToDisk();
}

async function refreshGemsCache() {
  try {
    const promises = GEM_NAMES.map((gemName) => {
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
          const buyPrice = first.AuctionInfo?.BuyPrice || first.AuctionInfo?.StartPrice || 0;

          // 2026년 8월 6일 추가: 보석 히스토리용 일일 스냅샷 기록
          // tradeCount 자리에는 실제 "거래 건수"가 아니라 그 시점에 경매장에 등록되어
          // 있던 매물 총 개수(TotalCount)를 대신 사용함 (공식 API 한계상 실거래 건수는 못 구함)
          recordGemSnapshot(gemName, buyPrice, gemData.TotalCount || 0);

          return {
            Name: first.Name || gemName,
            Icon: first.Icon || "",
            Grade: first.Grade || "영웅",
            BundleCount: 1,
            CurrentMinPrice: buyPrice,
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
  battleItems: refreshBattleItemsCache,
  esther: refreshEstherCache,
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
app.get("/markets/battleitems", (req, res) => sendCache("battleItems", res));
app.get("/markets/esther", (req, res) => sendCache("esther", res));
app.get("/auctions/items", (req, res) => sendCache("auctionEngravings", res));

// =================================================================
// ===== 아이템 상세 히스토리 (최근 10일 시세/거래량) - 2026년 8월 6일 추가 =====
// =================================================================
const ITEM_STATS_CACHE = new Map();
const ITEM_STATS_TTL = 5 * 60 * 1000; // 5분 캐시 (같은 아이템 반복 클릭 시 API 절약)

app.get("/markets/item/:itemId/stats", async (req, res) => {
  const { itemId } = req.params;
  const cached = ITEM_STATS_CACHE.get(itemId);
  const now = Date.now();

  if (cached && now - cached.timestamp < ITEM_STATS_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const key = getNextApiKey();
  if (!key) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }

  try {
    const response = await fetch(`${LOSTARK_BASE_URL}/markets/items/${itemId}`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${key}`,
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "아이템 히스토리를 불러오지 못했습니다." });
    }

    const data = await response.json();

    // 2026년 8월 6일 수정 (핵심 버그 수정):
    // 공식 API가 같은 이름의 아이템을 "변형" 여러 개를 배열로 줄 때가 있음.
    // (예: TradeRemainCount가 다른 두 항목 — 하나는 거래 이력이 전혀 없어 Stats가 전부 0,
    //  다른 하나는 실제 거래 데이터가 들어있는 진짜 항목)
    // 기존 코드는 무조건 배열의 0번째만 썼는데, 하필 그게 "빈" 변형이면 항상 0으로만 표시되는 문제가 있었음.
    // → 배열 안에서 TradeCount 합계가 가장 큰(=실제 거래가 있는) 항목을 골라 쓰도록 수정.
    const itemDataArray = Array.isArray(data) ? data : [data];

    function sumTradeCount(entry) {
      return (entry?.Stats || []).reduce((sum, s) => sum + (Number(s.TradeCount) || 0), 0);
    }

    const itemData = itemDataArray.reduce((best, cur) => {
      if (!best) return cur;
      return sumTradeCount(cur) > sumTradeCount(best) ? cur : best;
    }, null) || itemDataArray[0];

    const rawStats = itemData?.Stats || [];

    // 2026년 8월 6일 추가: 각인서 그래프가 계속 0으로 뜨는 문제 디버깅용 로그.
    // 배포 로그(cloudtype 콘솔)에서 실제 원본 필드명/값을 확인할 수 있음.
    // 정상적으로 나온다고 확인되면 이 로그는 지워도 됨.
    if (rawStats.length > 0) {
      console.log(`[debug] itemId=${itemId} (${itemData?.Name}) 원본 Stats 전체(최대10일):`, rawStats.slice(0, 10));
    } else {
      console.log(`[debug] itemId=${itemId} 응답에 Stats 필드가 비어있음. 원본 응답:`, itemData);
    }

    // 필드명이 흔들려도(대소문자 등) 방어적으로 읽음
    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
      }
      return null;
    };

    // 공식 API는 최신 날짜가 먼저 오므로, 최근 10일만 잘라서 날짜 오름차순(과거→최신)으로 뒤집음
    const stats = rawStats.slice(0, 10).reverse().map((s) => ({
      date: pick(s, ["Date", "date"]),
      avgPrice: Number(pick(s, ["AvgPrice", "avgPrice"])) || 0,
      tradeCount: Number(pick(s, ["TradeCount", "tradeCount"])) || 0,
    }));

    // 값이 전부 0이면(=진짜로 거래가 없었던 기간일 수 있음) 프론트에서 구분해서
    // 안내 문구를 보여줄 수 있도록 플래그를 같이 내려줌
    const allZero = stats.length > 0 && stats.every((s) => s.avgPrice === 0 && s.tradeCount === 0);

    const payload = {
      name: itemData?.Name || null,
      bundleCount: itemData?.BundleCount || 1,
      stats,
      allZero,
    };

    ITEM_STATS_CACHE.set(itemId, { data: payload, timestamp: now });
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error("아이템 히스토리 조회 실패:", err.message);
    res.status(502).json({ error: "아이템 히스토리 조회 중 오류가 발생했습니다." });
  }
});

// =================================================================
// ===== 보석 자체 히스토리 조회 (2026년 8월 6일 추가) =====
// 예: GET /markets/gems/stats?level=10&type=겁화
// =================================================================
app.get("/markets/gems/stats", (req, res) => {
  const { level, type } = req.query;

  if (!level || !type) {
    return res.status(400).json({ error: "level, type 쿼리 파라미터가 필요합니다. 예: ?level=10&type=겁화" });
  }
  if (!["겁화", "작열"].includes(type)) {
    return res.status(400).json({ error: "type은 '겁화' 또는 '작열'만 가능합니다." });
  }

  const gemName = `${level}레벨 ${type}의 보석`;
  if (!GEM_NAMES.includes(gemName)) {
    return res.status(404).json({ error: "지원하지 않는 보석입니다." });
  }

  const stats = GEM_HISTORY.get(gemName) || [];

  res.json({
    name: gemName,
    stats,
    note: "공식 API는 경매장 아이템의 과거 시세를 제공하지 않아, 이 서버가 매일 관측한 스냅샷을 누적한 데이터입니다. 서버가 켜져 있던 기간만큼만 쌓입니다.",
  });
});

// 오래된 아이템 히스토리 캐시 정리
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ITEM_STATS_CACHE.entries()) {
    if (now - entry.timestamp > ITEM_STATS_TTL * 3) {
      ITEM_STATS_CACHE.delete(key);
    }
  }
}, 15 * 60 * 1000);

// 서버 시작
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
