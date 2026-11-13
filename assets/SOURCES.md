# 그림·글꼴 출처

모두 `chatbotgmm/server`의 `backup/gmm-110-source-20261101`(커밋 `0b0fb8b5`)에서 가져왔어요. **GMM110 앱이 실제로 쓰는 것만** 골랐어요(사용자 결정 2026-11-13). 그림 내용은 바꾸지 않았고, 앱과 같은 자르기(crop)·크기 줄이기·webp 압축만 했어요. 다시 만드는 방법은 `tools/import-art.py` 맨 위에 있어요.

| 폴더 | 내용 | 원본 위치 | 앱에서 쓰는 곳(근거) |
|---|---|---|---|
| `units/` | 60종 앞·뒷모습 120장(긴 변 512px) | `app/android/app/src/main/assets/roster60-art/` | `GameResourcePreparation.java` 77~78줄 |
| `village/` | 마을 하늘·구역 배경·건물·주민·석상 5단계 + `village.json`(배치) | `art/gpt/village-*`, `art/gpt/statue-canonical-stages-20261027/` | `native/village-loop-v2/manifest.json`, `build.gradle`의 `bundleGameArt` 복사 규칙 |
| `title/` | 첫 화면 배경(아침·낮·저녁·밤) | `app/android/app/src/main/assets/native/journal/c-home-*.webp` | `NativeArt.java` 262줄 |
| `ui/` | 전투 배경·명령 아이콘·나인패치 칸·버튼(`ninepatch.json`에 늘림 영역) | `art/gpt/ui-v3-20261025/runtime/` | `build.gradle`의 `ui-v3` 복사 목록 |
| `fonts/` | Jua(제목·버튼), Gowun Dodum(본문) woff2 + OFL 라이선스 | `public/site/a/` | 앱 assets에 같은 글꼴(ttf)이 들어 있음 |

뺀 것:
- 글자가 그림에 들어 있는 이름판(`nameplates.png` 등). 실제 글자로 그려요(UI-COLOR 규칙: 글자가 포함된 이미지 버튼 대신 실제 텍스트).
- 예전 수비대(33종) 그림, 145종 카드. 새 프로젝트에서 빼기로 했어요.
