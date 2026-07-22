# LOA Proxy Server

로스트아크 API 키를 프론트엔드(GitHub Pages)에 노출하지 않기 위한 프록시 서버.

## 배포 순서 (클라우드타입)

1. 이 폴더(server.js, package.json)를 **새 깃허브 저장소**에 올린다.
   ⚠️ 기존 loaviewer.github.io 저장소와는 **다른, 별도의** 저장소여야 함.
2. https://developer-lostark.game.onstove.com 에서 API 키를 재발급/추가 발급받는다.
   (기존에 코드에 노출됐던 키는 폐기, 계정당 최대 5개 + 부계정 활용 시 그 이상도 가능)
3. cloudtype.io 접속 → GitHub 로그인 → 새 프로젝트 생성
4. + 버튼 → 방금 만든 저장소 연결 → Node.js 선택
5. **Environment variables**에 아래처럼 등록 (키가 몇 개든 이 방식 하나로 처리됨):
   - `LOSTARK_API_KEYS` = `키1,키2,키3,키4,키5,키6,키7,키8,키9,키10`
   - (콤마로만 구분, 띄어쓰기 있어도 자동으로 제거됨. 키가 1개뿐이면 콤마 없이 값 하나만 넣어도 됨)
6. 배포 실행 → 완료되면 `https://xxxx.cloudtype.app` 같은 도메인 생성됨
7. server.js의 `ALLOWED_ORIGINS`에 실제 사이트 주소가 맞는지 확인

## 키 순차 사용(라운드로빈) 방식

서버가 요청을 받을 때마다 `LOSTARK_API_KEYS`에 등록된 키를 **첫 번째 → 두 번째 → ... → 마지막 → 다시 첫 번째** 순서로 자동으로 돌려가며 사용한다.
키 개수는 코드에 영향 없이 환경변수 값만 늘리거나 줄이면 되고, 자동으로 분산돼서 키 하나당 걸리는 호출 제한(rate limit) 부담이 줄어든다.

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
