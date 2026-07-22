// server.js
// 로스트아크 API 프록시 서버
// - 클라이언트(사이트)는 이 서버에만 요청을 보내고,
// - 이 서버가 대신 로스트아크 공식 API에 키를 붙여서 호출한 뒤 결과를 돌려줌
// - API 키는 절대 이 파일에 직접 쓰지 않고, 클라우드타입 "환경변수"에만 저장함

const express = require("express");
const cors = require("cors");

const app = express();

// 환경변수에서 키를 읽어옴 (클라우드타입 배포 시 여기에 값을 넣어줌)
const LOSTARK_API_KEY = process.env.LOSTARK_API_KEY;
const LOSTARK_BASE_URL = "https://developer-lostark.game.onstove.com";

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
  if (!LOSTARK_API_KEY) {
    return res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
  }

  try {
    const response = await fetch(`${LOSTARK_BASE_URL}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${LOSTARK_API_KEY}`,
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

// 예시 2) 경매장 검색 (필요하면 나중에 추가로 확장 가능)
// app.post("/auctions/items", ...) 처럼 필요한 엔드포인트는 계속 추가하면 됨

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`프록시 서버 실행 중 (포트: ${PORT})`);
});
