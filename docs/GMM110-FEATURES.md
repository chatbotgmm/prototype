# GMM110 방범대 기능 목록 (다시 만들 기준)

작성 2026-11-13. 이 문서는 새로 만들 게임이 **무엇을 갖춰야 하는지**의 기준표예요.

## 기준 소스
- 저장소 `chatbotgmm/server`, 브랜치 `backup/gmm-110-source-20261101`, 커밋 `0b0fb8b5c528c3bf15029cfd74334ad89d7d5500` (2026-11-01).
- 앱: `versionCode 110`, `versionName "2.2.8-native"`, 패키지 `org.dpdns.gmm.native.revised` (`galmaegiman-confirmed/app/android/app/build.gradle`).
- 아래 경로는 모두 위 커밋의 `galmaegiman-confirmed/` 기준이에요.

## 읽은 범위와 한계
- 읽은 것: 서버 경로 등록 코드(`src/roster60-routes.ts`, `src/story/routes.ts`, `src/native.ts`, `src/my.ts`), 전투 규칙(`src/battle/roster60-*.ts`), 데이터(`data/test-profiles/five-stat-device-test-v1/*`, `data/story/story-mode-v1.json`, `data/roster60-recruit-policy.json`), DB 모델 이름(`prisma/schema.prisma`), 문서 `docs/CONFIRMED-POLICIES-20261027.md` 외 8개.
- 앱 화면은 **파일·함수 이름과 문서로만** 확인했어요. Java 238개 파일(약 45,961줄)을 한 줄씩 다 읽지는 않았어요. 화면별 세부 동작은 해당 기능을 만들 때 원본을 다시 읽고 이 문서를 고쳐요.
- 「확정」은 원본 문서에 사용자 확정·승인으로 적힌 것만이에요. 나머지 수치는 원본이 스스로 **시험값**이라고 표시해요(`productionBalanceApproved: false`).

## 1. 세계와 이름
- 앱 제목은 「갈매미맨 방범대」예요(`MainActivity.java`: `text("갈매미맨 방범대", 24)`). 계정 화면 이름은 「방범대 인사 기록부」예요.
- 플레이어는 **방범대장**이에요. 개체와 별도로 대장 레벨이 있어요(4장).

## 2. 갈매미 60종 (새 체계)
출처: `data/test-profiles/five-stat-device-test-v1/catalog.json`
- 60종 `u01`~`u60`. `u01`의 이름은 반드시 「갈매미맨」이어야 해요(`roster60-rules.ts`의 검사).
- 등급별 수: 커먼 8 · 언커먼 8 · 레어 8 · 에픽 8 · 전설 6 · 히든 6 · 제한 4 · 초월 4 · 불멸 4 · 영원 4.
- 능력치 다섯 개(`statSchema: gmm-five-stats-v1`): 체력(hp), MP, 내구(durability), 상태 저항(statusResistance), 속도(speed). 레벨별 표(`combatGrowth`)가 있어요.
- **갈매미 자체에는 속성이 없어요.** 속성은 기술에만 있어요(`CREATURE_ELEMENT_REMOVED` 검사).
- 갈매미마다 속성별 **적합도**(suitability, 숫자)와 **방어 상성**(약점·보통·저항·무효·반사)을 가져요.
- 기술: 일반 공격 1개(MP 0)와 기술 최대 6개. 기술은 **유닛 레벨에 따라 해금**돼요(`learnLevel`, 사용자 확정 — `docs/OWNED-GULLS-20261028.md`).
- 기술 목록(`skillLibrary`) 32개. 기술 속성은 8종: 일반·불·물·번개·얼음·자연·신성·어둠.
- 카탈로그 상태: `approved: true`, `productionBalanceApproved: false`. 메모에 "모든 수치는 교체 가능한 시험 기준"이라고 적혀 있어요.

## 3. 전투 (1:1 교대, 턴제)
출처: `src/battle/roster60-five-combat.ts`, `roster60-rules.ts`, `src/roster60-battle.ts`, `battle-policy.json`
- 행동 네 가지: **공격**(기술 선택) · **집중**(focus) · **교체** · **아이템**.
- 편성: 출전 1마리 + 예비 최대 5마리(`battle/create`의 `reserveIds` 최대 5). 대전 편성은 1~6마리.
- 피해 = 위력 × 레벨 배율 × 내구 배율 → 그다음 속성 상성 처리
  - 레벨 배율 = 1 + 0.025 × (레벨 − 1)
  - 내구 배율 = 1 ÷ (1 + 내구 ÷ 50)
  - 0.025와 50은 시험값이에요(`combatPolicy`).
- 상태 이상 확률 = 기본 확률 ÷ (1 + 상태 저항 ÷ 50)
- 행동 순서: 속도가 빠른 쪽이 먼저예요. 같으면 서버 비밀 씨앗 해시로 정해서 다시 시도해도 결과가 같아요.
- 명중 100%, 급소 0, 피해 흔들림 없음(카탈로그 메모).
- 최대 100턴. 넘으면 무승부예요(`maxRounds: 100`, 시험값).
- 상대 정보 공개 범위와 패배 원인 안내 규칙이 있어요(`roster60-opponent-intel.ts`, `roster60-loss-feedback.ts`, `roster60-observed-defense.ts`). 원칙: 실제로 관측한 사실만 보여 주고, 패인을 지어내지 않아요(`CONFIRMED-POLICIES`).

## 4. 성장
- 개체 레벨 상한: 환생 전 **60**, 환생 뒤 **99**(`rosterMaxLevel`).
- 환생: 개체를 레벨 1로 되돌리고, 체력·MP·내구에 보너스를 더해요(`rebirthPolicy: hp-mp-durability-additive-v1`). 환생 뒤 레벨 2~60까지는 필요 경험치가 **70%**예요(`confirmedReincarnationXpPolicy`, 코드에 "확정"으로 적힘). 자동 환생은 없어요.
- 상한을 넘은 경험치는 버려요. 다른 개체로 옮기지 않아요(`CONFIRMED-POLICIES`).
- **방범대장 성장**: 개체 경험치와 따로 쌓여요(`src/progression/commander.ts`, `CommanderAccount`·`CommanderXpLedger`). 시험 지급량: 스토리 의뢰 200 · 주민 의뢰 450 · 독립 모험 귀환 100 · 일반전 승 100 / 패 50(`commander-policy.json`의 `rewards`).
- 조합 기술 계승: 조합할 때 재료가 가진 해금 기술 중 하나를 결과 개체의 한 칸과 바꿀 수 있어요(`docs/CRAFT-SKILL-INHERITANCE-20261028.md`).
- 임시 갈매미 레벨 계승: 임시로 빌려준 갈매미의 레벨을, 다음에 처음 얻는 같은 종류 영구 개체에 이어 줘요(사용자 확정 — `docs/STARTER-LEVEL-INHERITANCE.md`).

## 5. 획득
- **첫 갈매미 고르기**(onboarding): 시작 → 표 확인(preview) → 고르기(confirm) → 완료(`src/roster60-onboarding.ts`).
- **모집**(recruit session): 하급·중급·고급(`data/roster60-recruit-policy.json`)
  - 후보 한 장당 지원서 2 / 6 / 10장. 새로고침은 1 / 3 / 5장(`docs/RECRUIT-REJECTION-20261028.md`).
  - 하급: 커먼 70 · 언커먼 28 · 레어 2
  - 중급: 언커먼 70 · 레어 28 · 에픽 2
  - 고급: 레어 90 · 에픽 9 · 전설 0.5 · 히든 0.5
  - 등급 안에서는 균등하고 천장은 없어요. 들어올 때 레벨: 커먼·언커먼 1, 레어 10, 에픽 15, 전설·히든 20.
  - 후보마다 합격 · 새로고침 · 불합격(이미 가진 종이면 지원서 1장 환급)을 고를 수 있고, 「전부 합격」도 있어요.
- **조합**: 조합식 52개(`recipes`). 재료 종류·개수·최소 레벨이 있고, 결과는 미리보기 → 확인 순서예요. 히든 조합은 가려서 보여 줘요(`craft/options`의 발견 머리글).

## 6. 플레이 모드
- **스토리**(`data/story/story-mode-v1.json`, `src/story/*`)
  - 장 7개, 주민 4명, 장면 50개, 의뢰 25개, 조우 27개.
  - 흐름: 의뢰 수락 → 장면 대사 → 모험 출항에서 정해진 조우 승리 → 귀환 장면 → 완료.
  - 흑화 갈매미를 이기면 「어둠의 새우Gang」이 계정에 쌓여요(승리당 1, 데이터 키 `darkGangPerWin`. 앱 표시 문구는 `NativeRoster60StoryBattle.java`). 특정 의뢰는 지금까지 받은 누적량이 있어야 열려요(STORY_06: 2, STORY_12: 4, STORY_18: 6. 시험값, `mainLifetimeGates`).
  - 문서상 스토리 전투 27개의 개체 경험치는 원본 콘텐츠 값 0이고, 따로 시험 정책으로 연결했어요(`docs/STORY-UNIT-GROWTH-20261027.md`, `docs/XP-GRANT-CONNECTION-20261029.md`).
- **탐험/모험**(`src/roster60-adventure.ts`): 1~6마리 출발 → 귀환 정산. 보상은 파티 수로 나누지 않아요.
- **일반전**(`src/roster60-pvp.ts`): 실시간 매칭이고, 30초 뒤 AI와 붙어요.
  - 개체 경험치: 정상 승리 100%, 정상 패배 50%, 항복·도주 0. 출전 개체끼리 똑같이 나눠요(확정 — `CONFIRMED-POLICIES`).
  - 연결이 끊긴 뒤 돌아올 유예가 있어요(45초 + 45초. 시험값).
- **랭크전**: 대장 레벨 60 이상 + 편성한 모든 개체 60 이상이어야 해요(확정). 랭크 AI는 없어요. 환생 경험이 있는 계정과 없는 계정을 나눠서 매칭해요.
- 훈련 조우: `battle-policy.json`의 `encounters`(tutorial, training-1/5/10/20 …).

## 7. 마을(메인 화면)
출처: `docs/VILLAGE-HOME-IMPLEMENTATION-20261027.md`, `VILLAGE-ART-INTEGRATION-20261027.md`
- 좌우로 끝없이 도는 2.5D 마을(구역 네 개, 관성 스크롤). 건물을 누르면 기능으로 가요.

| 건물 | 기능 |
|---|---|
| 방범대 지원소 | 모집 |
| 방범대 아지트 | 편성 |
| 기록소 | 도감, 조합 |
| 우편함 | 우편, 이벤트 소식, 공지 |
| 바닷가 플레이 | 탐험, 스토리, 일반게임, 랭크게임 |
| 시장 | 아이템 상점, 플레이 패스, 재화 교환 |

- 주민과 대화하고, 주민 의뢰(「새 부탁」)를 받아요. 마을 바로가기와 의뢰 추적 표시가 있어요(`NativeVillageShortcuts`, `NativeVillageQuestTracker`).
- 메뉴 묶음 이름(서버 `src/menu-access.ts`): 모집 · 보유 · 조합 · 모험 · 상점 · 편성 · 일일 · 환생. 지금은 모두 열려 있고, 잠금 기능은 꺼져 있어요(`MENU_ACCESS_RETIRED`).

## 8. 그 밖의 화면 (파일 이름으로 확인)
- 내 갈매미(보유 개체 하나씩 넘기기, 상세 능력치·속성·기술): `NativeOwnedGulls`, `NativeUnitDossier`
- 도감·종 캐러셀: `NativeRoster60Library`, `NativeCatalogCarouselView`
- 경험치 영수증·보상 연출: `NativeXpReceipt`, `NativeXpRewards`
- 닉네임 정하기 `NativeNicknameSetup`, 소식·우편 `NativeNews`, 설정 `NativeSettingsSheet`, 튜토리얼 `NativeTutorial*`, 필수 업데이트 안내 `NativeRequiredUpdate`, 소리 `NativeSound`

## 9. 계정·로그인
- 카톡 채널에서 받은 6자리 코드 로그인, 카카오 로그인(앱은 PKCE), 앱 심사용 로그인(`src/my.ts`, `src/review-auth.ts`).
- 서버가 판정하고 앱은 보여 주기만 해요. 모든 쓰기 요청에 `requestId`(같은 요청을 다시 보내도 한 번만 처리)와 `revision`(낡은 화면에서 보낸 명령 거절)을 붙여요.

## 10. 같은 저장소에 섞여 있던 예전 체계 (다시 만들지 않을 후보)
GMM110 안에는 위 새 체계와 함께 예전 코드가 남아 있어요. 사용자가 말한 「코드가 겹친다」의 실제 내용이에요.
- 예전 「수비대 대결」 전투(10속성·3:3·증강체): `src/battle/engine.ts`, `augment-*.ts`, `src/native.ts`
- 카톡 챗봇 뽑기·조합(145종): `src/game.ts`(2,443줄), `src/gacha.ts`, `data/units.json`
- 예전 실시간 대전·랭크 정산: `src/pvp/*`, `src/ranked/*`
- 시험판 웹: `/duel`, `/play`, `/battle`, `/game`
- DB 모델 59개 가운데, 이름이 `Roster60*`·`Commander*`인 것이 새 체계예요. 나머지(`StorySave`, `Realtime*`, `Ranked*`, `Progression*` 등)는 예전 체계 또는 공용이에요.

어떤 것을 가져오고 어떤 것을 버릴지는 `docs/ARCHITECTURE.md`의 「정해야 할 것」에 적었어요.
