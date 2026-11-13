# 데이터

모두 `chatbotgmm/server`의 `backup/gmm-110-source-20261101`(커밋 `0b0fb8b5`)에서 그대로 복사했어요. 내용은 바꾸지 않았어요.

| 파일 | 원본 위치 | 상태 |
|---|---|---|
| `catalog.json` | `data/test-profiles/five-stat-device-test-v1/catalog.json` | 시험값 (`productionBalanceApproved: false`) |
| `battle-policy.json` | 같은 폴더 `battle-policy.json` | 시험값 |
| `commander-policy.json`, `commander-reward-schedule.json` | 같은 폴더 | 시험값 |
| `normal-xp-policy.json`, `story-unit-xp-policy.json`, `unit-xp-pacing-policy.json` | 같은 폴더 | 시험값 |
| `recruit-policy.json` | `data/roster60-recruit-policy.json` | 원본 메모: "최신 모집풀과 확률 적용" |
| `story/*.json` | `data/story/` | `story-mode-v1.json`은 시험값 |
| `items.json` | `data/battle.yaml`의 `items` 부분을 JSON으로 옮김 | 60종 전투가 실제로 쓰는 아이템 정의 |

검사: `npm run data:check`
