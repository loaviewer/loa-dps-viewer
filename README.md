# LOA Proxy Server

로스트아크 API 키를 프론트엔드(GitHub Pages)에 노출하지 않기 위한 프록시 서버.

## 배포 순서 (클라우드타입)

1. 이 폴더(server.js, package.json)를 **새 깃허브 저장소**에 올린다.
   ⚠️ 기존 loaviewer.github.io 저장소와는 **다른, 별도의** 저장소여야 함.
2. https://developer-lostark.game.onstove.com 에서 API 키를 새로 재발급받는다.
   (기존에 코드에 노출됐던 키는 폐기)
3. cloudtype.io 접속 → GitHub 로그인 → 새 프로젝트 생성
4. + 버튼 → 방금 만든 저장소 연결 → Node.js 선택
5. **Environment variables**에 다음을 추가:
   - `LOSTARK_API_KEY` = 새로 발급받은 키 값
6. 배포 실행 → 완료되면 `https://xxxx.cloudtype.app` 같은 도메인 생성됨
7. server.js의 `ALLOWED_ORIGINS`에 실제 사이트 주소가 맞는지 확인

## 프론트엔드(loaviewer.github.io)에서 사용법

기존 config.js에서 API 키를 완전히 삭제하고, 아래처럼 프록시 주소만 남긴다.

```js
// config.js (수정 후)
const PROXY_BASE_URL = "https://xxxx.cloudtype.app"; // 클라우드타입에서 받은 실제 주소로 교체
```

기존에 로스트아크 API를 직접 호출하던 코드:
```js
fetch("https://developer-lostark.game.onstove.com/armories/characters/시로/profiles", {
  headers: { authorization: `bearer ${LOSTARK_API_KEY}` }
})
```

이렇게 바뀜:
```js
fetch(`${PROXY_BASE_URL}/character/시로`)
```

→ 키는 완전히 클라우드타입 서버 안에만 존재하고, 깃허브 코드에는 전혀 노출되지 않음.
