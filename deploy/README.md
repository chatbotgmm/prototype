# 기존 도메인 아래 배포: https://gmm.dpdns.org/proto/

시제품을 운영 중인 EC2에 **따로** 띄워요. 운영 게임 서버(`gmm-server`, 포트 3000)와 DB는 건드리지 않아요.

```
휴대폰 → https://gmm.dpdns.org/proto/... → Cloudflare 터널(gmm-named-tunnel)
                                              ├─ /proto 로 시작하면 → 127.0.0.1:3100 (시제품 gmm-proto, ~/proto/storage/proto.db)
                                              └─ 그 밖의 모든 주소    → 127.0.0.1:3000 (기존 게임 서버, 그대로)
```

## 처음 설치 (EC2 Session Manager, 한 줄씩)
```bash
sudo -iu ubuntu
```
```bash
git clone https://github.com/chatbotgmm/prototype.git ~/proto && bash ~/proto/deploy/install.sh
```
- 저장소가 비공개라서, `git clone`이 인증 오류를 내면 기존 서버를 받을 때 쓰는 GitHub 토큰에 `chatbotgmm/prototype` 접근 권한을 추가해 주세요.
- 설치 스크립트 순서: 설치·빌드 → **시험(실패하면 멈춤)** → `.env`(비밀값 자동 생성) → 시제품 DB → 서비스 `gmm-proto` → 터널 설정에 `/proto` 규칙 한 개 추가(먼저 백업, 검사 통과 못 하면 자동 되돌림) → 바깥 주소 확인.
- 마지막에 `✅ 시제품: https://gmm.dpdns.org/proto/`와 `✅ 기존 게임 서버도 그대로 응답`이 나오면 끝이에요.
- 터널을 Cloudflare 화면에서 관리하는 방식이면, 스크립트가 터널 설정을 바꾸지 않고 화면에서 추가할 값을 알려 줘요.

## 시험 계정 코드 받기
```bash
cd ~/proto && node --env-file=.env --import tsx tools/issue-codes.ts 내이름
```
- 처음 부르면 시험 계정을 만들고 시작 갈매미 5마리를 넣어 줘요. 6자리 코드 5개(한 번씩, 24시간)를 화면에 찍어요.
- 휴대폰에서 `https://gmm.dpdns.org/proto/` → 게임 시작 → 코드 입력.

## 업데이트
```bash
sudo -iu ubuntu bash ~/proto/deploy/update.sh
```
시험이 실패하면 이전 코드로 되돌리고 서비스는 그대로 둬요. DB는 반영 전에 `storage/proto.db.bak-날짜`로 복사해요.

## 상태 보기
```bash
sudo systemctl status gmm-proto --no-pager | head -15
```
```bash
sudo journalctl -u gmm-proto -n 50 --no-pager
```

## 되돌리기
시제품만 끄기(기존 게임에는 영향 없음):
```bash
sudo systemctl disable --now gmm-proto
```
터널 설정도 설치 전으로(설치 때 찍힌 백업 파일 이름을 넣어서):
```bash
cp ~/.cloudflared/config.yml.bak-proto-날짜 ~/.cloudflared/config.yml && sudo systemctl restart gmm-named-tunnel
```

## 알아 둘 것
- 시제품은 **시험 계정만** 로그인돼요(사용자 결정). 운영 카톡 계정·DB와 연결하지 않아요.
- 시제품 서버는 TypeScript를 `tsx`로 바로 실행해요(빌드 단계를 줄인 시제품용 방식).
