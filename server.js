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

async function fetchMarketCategory(categoryCode, res) {
  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "API 키 없음" });
  }

  try {
    const baseBody = {
      Sort: "CURRENT_MIN_PRICE",
      CategoryCode: categoryCode,
      ItemTier: null,
      ItemGrade: "",
      ItemName: "",
      SortCondition: "ASC"
    };

    const firstRes = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${currentKey}`,
      },
      body: JSON.stringify({ ...baseBody, PageNo: 1 }),
    });

    const firstData = await firstRes.json();
    if (!firstRes.ok) return res.status(firstRes.status).json(firstData);

    const allItems = Array.isArray(firstData.Items) ? [...firstData.Items] : [];
    const totalPages = Math.ceil((firstData.TotalCount || 0) / (firstData.PageSize || 10));

    for (let page = 2; page <= totalPages; page++) {
      const pageRes = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `bearer ${currentKey}`,
        },
        body: JSON.stringify({ ...baseBody, PageNo: page }),
      });
      const pageData = await pageRes.json();
      if (pageRes.ok && Array.isArray(pageData.Items)) {
        allItems.push(...pageData.Items);
      }
    }

    res.json({ TotalCount: allItems.length, Items: allItems });

  } catch (err) {
    console.error("거래소 API 오류:", err.message);
    res.status(502).json({ error: "거래소 API 호출 오류" });
  }
}

// ===== 기존 라우트 =====
app.get("/character/:name", (req, res) => {
  const name = encodeURIComponent(req.params.name);
  callLostArk(`/armories/characters/${name}/profiles`, res);
});

app.get("/gamecontents/calendar", (req, res) => {
  callLostArk(`/gamecontents/calendar`, res);
});

app.get("/news/events", (req, res) => {
  callLostArk(`/news/events`, res);
});

app.get("/news/notices", (req, res) => {
  callLostArk(`/news/notices`, res);
});

// ===== 각인서 시세 (경매 계산기용 - 기존 유지) =====
app.get("/auctions/items", async (req, res) => {
  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }

  try {
    const baseBody = {
      Sort: "CURRENT_MIN_PRICE",
      CategoryCode: 40000,
      CharacterClass: null,
      ItemTier: null,
      ItemGrade: "유물",
      ItemName: "",
      SortCondition: "ASC"
    };

    const firstResponse = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${currentKey}`,
      },
      body: JSON.stringify({ ...baseBody, PageNo: 1 }),
    });

    const firstData = await firstResponse.json();

    if (!firstResponse.ok) {
      return res.status(firstResponse.status).json(firstData);
    }

    const allItems = Array.isArray(firstData.Items) ? [...firstData.Items] : [];
    const totalCount = firstData.TotalCount || 0;
    const pageSize = firstData.PageSize || 10;
    const totalPages = Math.ceil(totalCount / pageSize);

    for (let page = 2; page <= totalPages; page++) {
      const pageResponse = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `bearer ${currentKey}`,
        },
        body: JSON.stringify({ ...baseBody, PageNo: page }),
      });

      const pageData = await pageResponse.json();

      if (pageResponse.ok && Array.isArray(pageData.Items)) {
        allItems.push(...pageData.Items);
      }
    }

    res.json({
      PageNo: 1,
      PageSize: allItems.length,
      TotalCount: allItems.length,
      Items: allItems
    });
  } catch (err) {
    console.error("각인서 시세 API 호출 실패:", err.message);
    res.status(502).json({ error: "각인서 시세 API 호출 중 오류가 발생했습니다." });
  }
});

// ===== 시세 페이지용 거래소 라우트 =====

// 강화 재료
app.get("/markets/enhance", (req, res) => {
  fetchMarketCategory(50010, res);
});

// 각인서
app.get("/markets/engravings", (req, res) => {
  fetchMarketCategory(40000, res);
});

// 배틀 아이템
app.get("/markets/battle", (req, res) => {
  fetchMarketCategory(60100, res);
});

// 요리
app.get("/markets/cook", (req, res) => {
  fetchMarketCategory(90200, res);
});

// 생활 재료
app.get("/markets/life", (req, res) => {
  fetchMarketCategory(90000, res);
});

// ===== 보석 시세 (경매장 API 사용) =====
app.get("/markets/gems", async (req, res) => {
  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "API 키 없음" });
  }

  try {
    const gemNames = [
      "10레벨 겁화의 보석",
      "9레벨 겁화의 보석",
      "8레벨 겁화의 보석",
      "7레벨 겁화의 보석",
      "10레벨 작열의 보석",
      "9레벨 작열의 보석",
      "8레벨 작열의 보석",
      "7레벨 작열의 보석"
    ];

    const allItems = [];

    for (const gemName of gemNames) {
      try {
        const gemRes = await fetch(`${LOSTARK_BASE_URL}/auctions/items`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `bearer ${currentKey}`,
          },
          body: JSON.stringify({
            Sort: "BUY_PRICE",
            CategoryCode: 210000,
            ItemTier: 4,
            ItemName: gemName,
            PageNo: 1,
            SortCondition: "ASC"
          }),
        });

        const gemData = await gemRes.json();

        if (gemRes.ok && gemData.Items && gemData.Items.length > 0) {
          const first = gemData.Items[0];
          allItems.push({
            Name: first.Name || gemName,
            Icon: first.Icon || "",
            Grade: first.Grade || "영웅",
            BundleCount: 1,
            CurrentMinPrice: first.AuctionInfo?.BuyPrice || first.AuctionInfo?.StartPrice || 0,
            RecentPrice: first.AuctionInfo?.BuyPrice || 0,
            YDayAvgPrice: first.AuctionInfo?.BuyPrice || 0
          });
        }
      } catch (gemErr) {
        console.error("보석 개별 조회 실패:", gemName, gemErr.message);
      }
    }

    res.json({ TotalCount: allItems.length, Items: allItems });

  } catch (err) {
    console.error("보석 시세 API 오류:", err.message);
    res.status(502).json({ error: "보석 시세 API 호출 오류" });
  }
});

// ===== 서버 시작 =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
