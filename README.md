# 갈매미맨 방범대 — 새 시제품

GMM110 방범대 네이티브 앱을 기준으로 게임을 깨끗하게 다시 만드는 저장소예요. 웹에서 먼저 만들어 다듬고, 완성되면 Godot으로 옮겨 출시해요.

- 기능 목록(다시 만들 기준): [docs/GMM110-FEATURES.md](docs/GMM110-FEATURES.md)
- 구조 설계(제안): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 작업 규칙: [CLAUDE.md](CLAUDE.md)

- API 명세(초안): [docs/API.md](docs/API.md)

## 지금 상태: 2단계
- `shared/`: 60종 규칙 엔진(레벨·경험치, 피해, 행동 순서, 환생 능력치, 전투 개체, PvE 전투 한 턴). GMM110 원본을 실제로 돌려 만든 기준 결과와 비교 시험 통과.
- `data/`: 60종 카탈로그·전투 정책·스토리·각종 정책(GMM110에서 복사, 시험값 표시 유지).

## 개발
```bash
npm install
npm test             # 규칙 시험(GMM110과 같은 결과인지 비교 포함)
npm run data:check   # 데이터 검사
npm run check        # 타입 검사
```
