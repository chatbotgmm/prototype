# API 명세 v0.3 (웹·Godot 공통)

상태: 3단계에서 **실제로 만든 것**은 「구현됨」으로 표시했어요. 나머지는 초안이에요. 코드: `server/src/app.ts`, `server/src/battle-service.ts`. 원본은 GMM110의 `/my/api/native/roster60/*`예요.

## 공통
- 주소: `<기본 경로>/api/v1/...`. 기본 경로는 환경 변수 `BASE_PATH`로 정하고, 기본값은 `/proto`예요. 운영에서는 `https://gmm.dpdns.org/proto/api/v1/...`이 될 예정이에요(배포는 아직).
- 인증: 웹은 쿠키 `gmm_proto`(경로 = 기본 경로, HttpOnly), 앱(Godot)은 머리글 `x-gmm-s: <토큰>`.
  - 로그인할 때 `x-gmm-app: 1`을 붙이면 응답에 토큰을 줘요.
- 모든 요청에 `x-gmm: 1`이 있어야 해요. 없으면 403 `FORBIDDEN`이에요(다른 사이트에서 몰래 보내는 요청 막기).
- 쓰기 요청은 `requestId`(1~100자)를 가져요.
  - 같은 `requestId`와 같은 내용이면 처음 결과를 그대로 돌려줘요.
  - 같은 `requestId`인데 내용이 다르면 409 `REQUEST_ID_REUSED`예요.
- 전투 명령은 `revision`을 가져요. 서버 값과 다르면 409 `STALE_REVISION`이에요.
- 오류 응답은 `{ "error": "<코드>" }`이고, 코드는 GMM110과 같은 문자열이에요.
  - 규칙 위반: 409
  - 입력 형식 오류: 400 `INVALID_REQUEST`
  - 로그인 필요: 401 `LOGIN_REQUIRED`
  - 없음: 404
- 수치가 시험값이면 응답에 `testBaseline: true`를 같이 줘요.

## 웹 화면 파일 (구현됨)
- `GET <기본 경로>/` 첫 페이지, `/app.js`(묶음, `npm run web:build`로 만듦), `/style.css`, `/assets/*`(그림·글꼴, 하루 캐시). `assets` 밖의 파일은 404.

## 계정 (구현됨)
| 방법 | 경로 | 내용 |
|---|---|---|
| GET | `/health` | `{ok, catalog, testBaseline}` (로그인 불필요) |
| POST | `/auth/code` | `{code}` 6자리. **시험 계정(`isTest`)만** 로그인돼요. 코드는 한 번만 쓸 수 있어요. 실패하면 400 `LOGIN_CODE_INVALID` |
| POST | `/auth/logout` | 쿠키를 지워요 |
| GET | `/me` | `{playerId, nickname, credits, items[], commander:{level:null, reason:'COMMANDER_NOT_CONNECTED'}, testBaseline}`. 방범대장 레벨은 7단계에서 연결해요 |

## 보유 개체·편성 (구현됨)
| 방법 | 경로 | 내용 |
|---|---|---|
| GET / POST | `/party` | `{ownedIds}` 1~3마리, 중복 없이. 어기면 400 `INVALID_PARTY` |

## 전투 (구현됨: 훈련·튜토리얼 조우)
| 방법 | 경로 | 본문 |
|---|---|---|
| GET | `/battle/options` | 편성 가능한 개체, 조우 목록(`id, name, level, tutorial, mode`), `partyPolicy` |
| GET | `/battle/active` | 진행 중·정산 전 전투 목록(최대 20) |
| POST | `/battle` | `{requestId, ownedId, encounterId, reserveIds?}` (예비 최대 2) |
| GET | `/battle/:battleId` | |
| POST | `/battle/:battleId/action` | `{requestId, revision, action}` |
| POST | `/battle/:battleId/settle` | `{requestId, revision}`. 같은 전투는 한 번만 정산하고, 다시 부르면 첫 정산 결과를 돌려줘요 |

`action`:
- `{kind:'attack'}`: 일반 공격
- `{kind:'skill', skillId}`: 기술
- `{kind:'focus'}`: 집중(최대 MP의 50% 회복)
- `{kind:'switch', targetOwnedId}`: 교체. 쓰러진 뒤 교체는 턴을 쓰지 않아요
- `{kind:'item', itemId, targetOwnedId?}`: 아이템
- `{kind:'escape'}`: 대결·스토리에서는 항복(패배), 모험에서는 70% 확률 도망

전투 응답:
```
{ testBaseline, balanceProfile, battleId, revision, status: ACTIVE|FINISHED|SETTLED,
  state: { mode, turn, outcome: win|loss|draw|escaped|null, surrendered,
           self:   내 출전 개체(전체 값 + ownResistance),
           reserves: 내 예비[],
           enemy:  상대(능력치는 opponentIntel.statsKnown일 때만 전체, 아니면 hp·mp 최대치만),
           opponentIntel: { statsKnown, defenses: 속성별 반응 또는 'unknown', defenseKnowledgeScope, knownDefenseCount, ... },
           decision: { order, tie, ... (speeds는 statsKnown일 때만) },
           rounds: [{ turn, decision?, events: [...] }], participation },
  settlement: 정산 뒤 { outcome, xpAwarded, xpDiscarded, xpByOwnedId, totalXp, policyVersion, unitXp:{ units:[{ ..., xpProgress:{before, after} }] } },
  itemDefinitions, inventory: [{itemId, count}],
  disabledCommands: { item, switch, escape } (빈 문자열이면 사용 가능) }
```
- 사건(`events`) 종류: `skill`(damage, target: defender|attacker, defense, reflected, suitabilityMultiplier, observedDefense?), `focus`(recovered), `switch`·`forced-switch`(from, to), `item`(itemId, targetOwnedId, recovered), `surrender`, `escape-success`, `escape-failed`
- **주지 않는 것**: 서버 씨앗, 상대 방어 표 전체, 관측 열쇠

## 첫 갈매미 (구현됨, 원본 roster60-onboarding.ts)
| 방법 | 경로 | 내용 |
|---|---|---|
| GET | `/onboarding` | `{started:false}` 또는 `{started, starter, tutorialVerified, tutorialComplete, ticket}` |
| POST | `/onboarding/start` | 갈매미맨(u01) 영구 지급(한 번만, 다시 불러도 같은 결과) |
| POST | `/onboarding/complete` | 튜토리얼 전투(`encounterId:'tutorial'`)를 이기고 정산한 뒤에만 「커먼 선택지급권」. 아니면 `TUTORIAL_NOT_VERIFIED` |
| POST | `/onboarding/preview` | `{ticketId}` → 커먼 7종(u02~u08) 정보 |
| POST | `/onboarding/confirm` | `{ticketId, characterId, catalogVersion}` → 한 마리 지급. 다른 종으로 다시 고르면 `ALREADY_REDEEMED` |

## 모집 (구현됨, 원본 roster60-recruit-session.ts)
| 방법 | 경로 | 내용 |
|---|---|---|
| GET | `/recruit` | 하급·중급·고급(비용·확률·새로고침 비용), 지원서, 처리 안 한 후보 |
| POST | `/recruit/start` | `{requestId, kind:LOW\|MID\|HIGH, catalogVersion, times(1~50)}` → 후보 `times`장. 처리 안 한 후보가 있으면 `RECRUIT_SESSION_PENDING` |
| POST | `/recruit/action` | `{requestId, sessionId, revision, action:reroll\|claim\|reject}`. 새로고침은 한 번(반값), 불합격은 이미 가진 종일 때만(지원서 1장 환급) |
| POST | `/recruit/claim-all` | `{requestId, sessions:[{sessionId, revision}]}` 같은 묶음 전부 합격 |
- 후보마다 `canReject`, `rejectReason`(`NOT_OWNED_SPECIES` 등)을 같이 줘요.

## 조합·도감·보유 개체 (구현됨)
| 방법 | 경로 | 내용 |
|---|---|---|
| GET | `/craft/options[?discovery=1]` | 쓸 수 있는 개체, 조합식별 재료 준비 상태(발견 못 한 결과·재료는 `???`) |
| POST | `/craft/preview` | `{resultId, materialIds, catalogVersion, inheritance?}` → 결과 레벨(재료 경험치 평균), 기술 계승 후보·바꿀 칸, `previewFingerprint` |
| POST | `/craft/confirm` | 위 + `{requestId, previewFingerprint}`. 계승 선택 필수(`INHERITANCE_SELECTION_REQUIRED`), 재료 상태가 바뀌면 `PREVIEW_CHANGED`. 재료는 `CONSUMED`가 되고 편성에서도 빠져요 |
| GET | `/collection` | 60종 전체, 보유 수, 발견 여부, 공격으로 관측한 방어 상성 |
| GET | `/owned` | 보유 개체(레벨 높은 순, 재료로 쓴 개체 제외) |
| GET | `/owned/:ownedId` | `{unit}`: 능력치(기본·성장·환생), 적합도, 내 방어 상성, 기술 칸(해금·계승), 다음 해금, 편성 위치 |

## 다음 단계에서 만들 묶음 (초안)
- 마을(home), 스토리/의뢰, 모험, 일반전/랭크전, 환생, 방범대장, 상점/우편/일일
- GMM110 원본 경로는 원본 `src/roster60-routes.ts`, `src/story/routes.ts`를 기준으로 옮겨요.
