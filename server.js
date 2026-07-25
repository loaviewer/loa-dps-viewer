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

// ===== 각인서 시세 (거래소) =====
app.get("/auctions/items", async (req, res) => {
  const currentKey = getNextApiKey();
  if (!currentKey) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }

  try {
    const body = {
      Sort: "CURRENT_MIN_PRICE",
      CategoryCode: 40000,
      CharacterClass: null,
      ItemTier: null,
      ItemGrade: "유물",
      ItemName: "",
      PageNo: 1,
      SortCondition: "ASC"
    };

    const response = await fetch(`${LOSTARK_BASE_URL}/markets/items`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `bearer ${currentKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("각인서 시세 API 호출 실패:", err.message);
    res.status(502).json({ error: "각인서 시세 API 호출 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
