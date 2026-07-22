// server.js
// 로스트아크 API 프록시 서버
// - 클라이언트(사이트)는 이 서버에만 요청을 보내고,
// - 이 서버가 대신 로스트아크 공식 API에 키를 붙여서 호출한 뒤 결과를 돌려줌
// - API 키는 절대 이 파일에 직접 쓰지 않고, 클라우드타입 "환경변수"에만 저장함

const express = require("express");
const cors = require("cors");

const app = express();

// 환경변수에서 키들을 읽어옴 (클라우드타입에서 LOSTARK_API_KEYS 하나에 콤마로 구분해서 등록)
// 예: LOSTARK_API_KEYS = "키1,키2,키3,...,키10"
// 키 개수는 몇 개든 상관없음 (1개여도 되고, 10개, 20개여도 됨)
const API_KEYS = (process.env.LOSTARK_API_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean); // 빈 값 제외

const LOSTARK_BASE_URL = "https://developer-lostark.game.onstove.com";

// 다음에 쓸 키의 순번을 기억하는 변수 (요청마다 하나씩 증가)
let keyIndex = 0;

// 호출할 때마다 순서대로 다음 키를 반환 (마지막 키까지 쓰면 다시 첫 번째로 돌아감)
function getNextApiKey() {
  if (API_KEYS.length === 0) return null;
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

// 어떤 도메인에서 이 서버를 호출해도 되는지 제한 (내 깃허브 사이트만 허용)
// 실제 슈쿠 사이트 주소로 바꿔줘. 여러 개면 배열로 추가 가능.
const ALLOWED_ORIGINS = [
  "https://loaviewer.github.io",
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
  })
);

// 서버가 살아있는지 확인용 (클라우드타입 배포 확인할 때 씀)
app.get("/", (req, res) => {
  res.send("LOA proxy server is running");
});

// 공통 프록시 함수: 로스트아크 API의 특정 경로를 그대로 대신 호출해줌
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

// 예시 1) 캐릭터 정보 조회
// 프론트에서: fetch(`https://내프록시주소/character/시로`)
app.get("/character/:name", (req, res) => {
  const name = encodeURIComponent(req.params.name);
  callLostArk(`/armories/characters/${name}/profiles`, res);
});

// 메인 홈에서 쓰는 3개 엔드포인트
// 프론트에서: fetch(`${PROXY_BASE_URL}/gamecontents/calendar`)
app.get("/gamecontents/calendar", (req, res) => {
  callLostArk(`/gamecontents/calendar`, res);
});

// 프론트에서: fetch(`${PROXY_BASE_URL}/news/events`)
app.get("/news/events", (req, res) => {
  callLostArk(`/news/events`, res);
});

// 프론트에서: fetch(`${PROXY_BASE_URL}/news/notices`)
app.get("/news/notices", (req, res) => {
  callLostArk(`/news/notices`, res);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
