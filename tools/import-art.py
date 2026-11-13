#!/usr/bin/env python3
"""GMM110 앱이 실제로 쓰는 그림만 골라 webp로 압축해 assets/에 넣는다.

사용: python3 tools/import-art.py <GMM110 galmaegiman-confirmed 폴더> <마을 manifest.json>
  - 원본 폴더: chatbotgmm/server backup/gmm-110-source-20261101(0b0fb8b5)의 galmaegiman-confirmed를 푼 것
  - 마을 manifest: 같은 커밋의 app/android/app/src/main/assets/native/village-loop-v2/manifest.json
어떤 그림을 왜 고르는지는 assets/SOURCES.md에 적는다. 원본 픽셀은 바꾸지 않고, 자르기(crop)·크기 줄이기·압축만 한다.
"""
import json, os, sys
from PIL import Image

SRC, MANIFEST = sys.argv[1], sys.argv[2]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
written = []

def save(im, rel, max_side=None, quality=82, lossless=False):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if max_side and max(im.size) > max_side:
        s = max_side / max(im.size)
        im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
    im.save(path, 'WEBP', quality=quality, method=6, lossless=lossless)
    written.append((rel, im.size, os.path.getsize(path)))
    return im.size

def crop(im, c):
    w, h = im.size
    return im.crop((round(c[0] * w), round(c[1] * h), round(c[2] * w), round(c[3] * h)))

# 1) 60종 앞·뒷모습 (앱: GameResourcePreparation.java가 roster60-art/uXX-front|rear.webp를 읽음)
for n in range(1, 61):
    for side in ('front', 'rear'):
        im = Image.open(f'{SRC}/app/android/app/src/main/assets/roster60-art/u{n:02d}-{side}.webp').convert('RGBA')
        save(im, f'units/u{n:02d}-{side}.webp', max_side=512, quality=84)

# 2) 마을 (앱: NativeVillageHomeView + manifest. 빌드 때 build.gradle bundleGameArt가 art/gpt에서 복사)
m = json.load(open(MANIFEST))
src_of = {  # manifest의 빌드 결과 이름 → 원본 위치(build.gradle의 from/rename 규칙으로 확인)
    'recruit': 'art/gpt/village-v7-20261031/runtime/recruit-v7.png',
    'hideout': 'art/gpt/village-v7-20261031/runtime/hideout-v7.png',
    'mailbox': 'art/gpt/village-npc-20261027/mailbox.png',
    'market': 'art/gpt/village-districts-20261028/market-market.png',
    'harbor': 'art/gpt/village-districts-20261028/harbor-play.png',
    'training': 'art/gpt/village-layered-20261028/layered-training-v3.png',
    'blacksmith': 'art/gpt/village-npc-20261027/blacksmith.png',
    'merchant': 'art/gpt/village-layered-20261028/layered-merchant-grounded-v5.png',
    'librarian': 'art/gpt/village-npc-20261027/librarian.png',
    'patrol': 'art/gpt/village-companions-20261027/patrol.png',
    'market-forge': 'art/gpt/village-districts-20261028/market-forge.png',
    'layered-sky': 'art/gpt/village-layered-20261028/layered-sky.png',
    'layered-patrol': 'art/gpt/village-v7-20261031/runtime/layered-patrol-v7.png',
    'layered-approved': 'art/gpt/village-v7-20261031/runtime/layered-approved-v7-seam-r5.png',
    'layered-market': 'art/gpt/village-v7-20261031/runtime/layered-market-v7.png',
    'layered-join-patrol-approved': 'art/gpt/village-v7-20261031/runtime/layered-join-patrol-approved-v7.png',
    'layered-join-approved-market': 'art/gpt/village-layered-20261028/layered-join-approved-market-v5.png',
    'layered-join-market-patrol-wrap': 'art/gpt/village-v7-20261031/runtime/layered-join-market-patrol-wrap-v7.png',
    'layered-quay': 'art/gpt/village-layered-20261028/layered-quay-v5.png',
    'archive': 'art/gpt/village-layered-20261028/layered-library.png',
    'companions-shadows': 'art/gpt/village-companions-20261027/shadows.png',
}
for i in range(1, 6):
    src_of[f'statue-stage-{i}'] = f'art/gpt/statue-canonical-stages-20261027/stage-{i}.png'
village = {'source': 'GMM110 native/village-loop-v2/manifest.json (' + m['version'] + ')', 'assets': {}}
for key, rel in src_of.items():
    a = m['assets'][key]
    im = crop(Image.open(f'{SRC}/{rel}').convert('RGBA'), a.get('crop', [0, 0, 1, 1]))
    # 배경 그림은 화면 높이만큼(1280×720에서 2배까지) 보이므로 긴 변 1600, 건물·주민은 1024로 충분
    big = key.startswith('layered-') and key != 'layered-training'
    size = save(im, f'village/{key}.webp', max_side=1600 if big else 1024, quality=80)
    village['assets'][key] = {'file': f'village/{key}.webp', 'width': size[0], 'height': size[1], 'source': rel}
for k in ('worldUnits', 'districts', 'buildings', 'residents', 'landmark', 'districtScenery', 'decorations'):
    village[k] = m[k]
json.dump(village, open(os.path.join(OUT, 'village', 'village.json'), 'w'), ensure_ascii=False, indent=1)

# 3) 첫 화면 배경(시간대별) — 앱: NativeArt.java "native/journal/c-home-<시간대>.webp"
for phase in ('morning', 'day', 'evening', 'night'):
    save(Image.open(f'{SRC}/app/android/app/src/main/assets/native/journal/c-home-{phase}.webp').convert('RGB'), f'title/c-home-{phase}.webp', max_side=1600, quality=80)

# 4) 전투 화면 UI(ui-v3) — 앱: build.gradle가 ui-v3로 복사하는 목록
ui = 'art/gpt/ui-v3-20261025/runtime'
for name in ('bg-harbor', 'icon-attack', 'icon-goldenstrike', 'icon-shield', 'icon-item', 'icon-switch', 'icon-surrender', 'icon-back'):
    im = Image.open(f'{SRC}/{ui}/optimized/ui/{name}.webp')
    save(im.convert('RGB' if name == 'bg-harbor' else 'RGBA'), f'ui/{name}.webp', max_side=1600 if name == 'bg-harbor' else 128, quality=82)
# 나인패치: 바깥 1픽셀 표시를 읽어 늘림 영역을 기록하고, 그림은 표시를 뗀 뒤 저장(웹은 CSS border-image로 사용)
nine = {}
for name in ('button_attack', 'button_item', 'button_surrender', 'button_switch', 'panel_command', 'panel_hp'):
    im = Image.open(f'{SRC}/{ui}/android-ninepatch/{name}.9.png').convert('RGBA')
    w, h = im.size; px = im.load()
    mark = lambda xy: px[xy][3] > 0 and px[xy][:3] == (0, 0, 0)
    xs = [x for x in range(1, w - 1) if mark((x, 0))]; ys = [y for y in range(1, h - 1) if mark((0, y))]
    body = im.crop((1, 1, w - 1, h - 1))
    size = save(body, f'ui/{name}.webp', quality=88)
    nine[name] = {'file': f'ui/{name}.webp', 'width': size[0], 'height': size[1],
                  'slice': {'left': xs[0] - 1, 'right': (w - 2) - xs[-1], 'top': ys[0] - 1, 'bottom': (h - 2) - ys[-1]}}
json.dump(nine, open(os.path.join(OUT, 'ui', 'ninepatch.json'), 'w'), indent=1)

total = sum(s for _, _, s in written)
print(f'{len(written)}개, 합계 {total/1e6:.1f}MB')
