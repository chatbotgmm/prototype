# API 명세 초안 v0 (웹·Godot 공통)

상태: **초안**. 3단계(서버 뼈대)에서 만들면서 고쳐요. 원본은 GMM110의 `/my/api/native/roster60/*` 경로이고, 새 서버에서는 이름과 묶음을 정리했어요.

## 공통
- 주소: `https://gmm.dpdns.org/<시제품 경로>/api/v1/...` (경로는 서버 단계에서 정함). 본문은 JSON.
- 인증: 웹은 쿠키, 앱(Godot)은 머리글 `x-gmm-s: <토큰>`. 다른 사이트의 요청을 막으려고 모든 요청에 `x-gmm: 1`.
- 쓰기 요청은 모두 `requestId`(문자 1~100)를 가져요. 같은 `requestId`로 다시 보내면 처음 결과를 그대로 돌려줘요. 내용이 다르면 `REQUEST_ID_REUSED`.
- 상태를 바꾸는 전투·모험 명령은 `revision`도 보내요. 서버의 현재 값과 다르면 `STALE_REVISION`(낡은 화면에서 보낸 명령).
- 오류: HTTP 상태 + `{ "error": "<코드>" }`. 코드는 GMM110과 같은 문자열을 써요(예: `INSUFFICIENT_MP`, `FORCED_SWITCH_REQUIRED`). 화면 문구는 코드로 찾아요.
- 시험값 표시: 수치가 들어간 응답은 `testBaseline: true`를 같이 줘요(GMM110과 같음).

## 계정
| 방법 | 경로 | 내용 |
|---|---|---|
| POST | `/auth/code` | `{code}` 6자리 → 세션. 시제품은 **시험 계정만** 받아요 |
| POST | `/auth/logout` | 세션 끝 |
| GET | `/me` | 닉네임, 재화, 방범대장 레벨(정책 없으면 `null`) |

## 보유 개체·편성
| 방법 | 경로 | 내용 |
|---|---|---|
| GET | `/owned` | 보유 개체 목록: `ownedId, speciesId, name, rarity, level, maxLevel, stats, reincarnation, status` |
| GET | `/owned/:ownedId` | 상세: 능력치(기본·성장·환생 보정), 적합도, 내 방어 상성, 기술(해금 레벨, 사용 가능 여부), 다음 해금 |
| GET | `/party` · POST `/party` | 편성 읽기·저장. 1~3마리(출전 1 + 예비 2) |

## 전투 (PvE: 훈련·튜토리얼·스토리·모험 조우)
| 방법 | 경로 | 본문 | 내용 |
|---|---|---|---|
| GET | `/battle/options` | | 편성 가능한 개체, 조우 목록, 편성 규칙 |
| POST | `/battle` | `{requestId, ownedId, encounterId, reserveIds?, adventureId?}` | 전투 만들기 |
| GET | `/battle/:battleId` | | 현재 전투 상태 |
| POST | `/battle/:battleId/action` | `{requestId, revision, action}` | 행동 하나 |
| POST | `/battle/:battleId/settle` | `{requestId, revision}` | 끝난 전투 정산(경험치 등) |

`action`:
- `{kind:'attack'}` 일반 공격(MP 0)
- `{kind:'skill', skillId}` 기술
- `{kind:'focus'}` 집중(최대 MP의 50% 회복)
- `{kind:'switch', targetOwnedId}` 교체. 출전 개체가 쓰러졌을 때는 이 교체만 받고, 턴을 쓰지 않아요
- `{kind:'item', itemId, targetOwnedId?}` 아이템(깃털은 쓰러진 아군 대상)
- `{kind:'escape'}` 스토리·대결은 항복(패배), 모험은 70% 확률 도망

전투 상태 응답(화면에 바로 쓰는 모양):
- `battleId, revision, status(ACTIVE|FINISHED), turn, outcome(win|loss|draw|escaped|null)`
- `self`: 내 출전 개체 전체 값. `reserves`: 내 예비
- `enemy`: 상대. **공개 범위 규칙 적용**: 능력치는 한 턴이 끝난 뒤 공개, 방어 상성은 실제로 맞혀 본 속성만 공개(GMM110 `opponentIntel`·`observedDefense`, 아직 옮기지 않음)
- `rounds`: 턴별 사건(`skill`·`focus`·`switch`·`forced-switch`·`item`·`surrender`·`escape-*`). 피해 사건에는 `damage, target, defense, reflected, suitabilityMultiplier`
- `disabledCommands`: 지금 못 쓰는 명령과 이유 코드
- **주지 않는 것**: 서버 씨앗(seed), 상대 비공개 값

## 다음 단계에서 정할 묶음
마을(home) · 도감 · 첫 갈매미 · 모집 · 조합 · 스토리/의뢰 · 모험 · 일반전/랭크전 · 환생 · 방범대장 · 상점/우편/일일. GMM110 원본 경로는 `docs/GMM110-FEATURES.md`와 원본 `src/roster60-routes.ts`를 기준으로 옮겨요.
