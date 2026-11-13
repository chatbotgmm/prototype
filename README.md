# 갈매미맨 방범대 — 새 시제품

GMM110 방범대 네이티브 앱을 기준으로 게임을 깨끗하게 다시 만드는 저장소예요. 웹에서 먼저 만들어 다듬고, 완성되면 Godot으로 옮겨 출시해요.

- 기능 목록(다시 만들 기준): [docs/GMM110-FEATURES.md](docs/GMM110-FEATURES.md)
- 구조 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- API 명세: [docs/API.md](docs/API.md)
- 작업 규칙: [CLAUDE.md](CLAUDE.md)

## 지금 상태: 4단계(웹 화면)
- `shared/`: 60종 규칙 엔진 — 레벨·경험치, 피해, 행동 순서, 환생 능력치, 전투 개체, PvE 전투 한 턴, 경험치 정산(두 번 이기면 한 레벨), 상대 정보 공개·방어 상성 관측.
  - GMM110 원본을 실제로 돌려 만든 기준 결과와 비교하는 시험을 통과해요.
- `server/`: 시험 계정 코드 로그인, 보유 개체, 편성, 전투(만들기·행동·정산), 같은 요청 재전송 처리, 관측 저장.
- `data/`: 60종 카탈로그·전투 정책·스토리·각종 정책(GMM110에서 복사, 시험값 표시 유지).
- `web/`: 첫 화면 → 로그인 → 마을 → 편성 → 일반전(지금은 AI 연습 상대) → 전투 → 결과. GMM110 그림·배치·색을 따랐어요.
  - 장면 하나 = 파일 하나(`web/src/scenes/`), API·장면 관리는 `web/src/core/`(Godot의 autoload에 해당).
- `assets/`: GMM110 앱이 실제로 쓰는 그림만(60종·마을·첫 화면·전투 UI, 약 16MB). 출처는 `assets/SOURCES.md`.
- 아직 없는 것: 모험·스토리·모집·조합·도감·대전·환생·방범대장·상점·우편, 운영 배포.

## 개발
```bash
npm install
npm run db:generate  # Prisma 클라이언트 만들기(처음 한 번)
npm test             # 규칙 비교 시험 + 서버 통합 시험(임시 DB)
npm run data:check   # 데이터 검사
npm run check        # 타입 검사
npm run dev          # 화면 묶기 + 시험 서버 http://127.0.0.1:3999/proto/ (임시 DB, 로그인 코드가 터미널에 나옴)
node tools/design-review.mjs <결과 폴더>   # 디자인 검토 캡처·숫자 검사(시험 서버를 켠 상태에서)
```

운영 실행(`npm run server`)에는 환경 변수 `DATABASE_URL`, `SESSION_SECRET`(32자 이상)이 필요하고, 선택으로 `PORT`(기본 3100), `BASE_PATH`(기본 `/proto`)를 줄 수 있어요. 배포 절차는 아직 정하지 않았어요.
