#!/usr/bin/env bash
# 시제품을 기존 도메인 아래(https://gmm.dpdns.org/proto/)에 처음 설치한다. EC2에서 ubuntu 사용자로 실행.
#   sudo -iu ubuntu
#   bash <(curl -fsSL ...) 대신, 저장소를 받은 뒤:  bash ~/proto/deploy/install.sh
# 하는 일(멈추면 그 단계까지만 바뀜. 기존 게임 서버 gmm-server는 건드리지 않음):
#   1 저장소 받기(~/proto)  2 설치·빌드·시험  3 .env(비밀값 자동 생성)  4 DB 만들기
#   5 서비스 gmm-proto(127.0.0.1:3100)  6 터널에 /proto 경로 규칙 추가(설정 백업 → 검사 → 재시작)  7 주소 확인
# 되돌리기: deploy/README.md의 「되돌리기」
set -euo pipefail

HOST="${HOST:-gmm.dpdns.org}"
APP="${APP_DIR:-$HOME/proto}"
CF="${CF_DIR:-$HOME/.cloudflared}"
PORT="${PORT:-3100}"
REPO="${REPO:-https://github.com/chatbotgmm/prototype.git}"
SKIP_SYSTEMD="${SKIP_SYSTEMD:-}"   # 리허설용: 1이면 systemd·터널 재시작을 건너뜀
ok(){ echo "✅ $*"; }
die(){ echo "❌ $*"; exit 1; }

echo "▶ 0 확인: node 22 이상, git"
command -v git >/dev/null || die "git이 없어요."
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' || die "Node 22 이상이 필요해요(지금 $(node -v 2>/dev/null))."

echo "▶ 1 저장소 받기: $APP"
if [ -d "$APP/.git" ]; then ok "이미 있어요. 최신으로 받기"; git -C "$APP" pull --ff-only
else
  if ! git clone "$REPO" "$APP"; then
    echo "❌ 저장소를 받지 못했어요. chatbotgmm/prototype은 비공개라 GitHub 인증이 필요해요."
    echo "   - 기존 서버(chatbotgmm/server)를 받을 때 쓰는 토큰이 '선택한 저장소만' 권한이면, 그 토큰에 prototype 저장소도 추가해 주세요."
    echo "   - 다시 실행: bash deploy/install.sh (저장소를 받은 뒤) 또는 이 명령을 다시"
    exit 1
  fi
fi
cd "$APP"

echo "▶ 2 설치·빌드·시험"
npm ci --no-audit --no-fund
npx prisma generate --schema server/prisma/schema.prisma >/dev/null
npm run -s web:build
npm run -s data:check
npm test --silent >/tmp/gmm-proto-test.log 2>&1 || { tail -30 /tmp/gmm-proto-test.log; die "시험이 실패했어요. 설치를 멈춰요(아무 서비스도 바꾸지 않았어요)."; }
ok "시험 통과: $(grep -oE 'Tests +[0-9]+ passed' /tmp/gmm-proto-test.log | tail -1)"

echo "▶ 3 .env"
if [ -f .env ]; then ok "이미 있어요(그대로 둠)"
else
  mkdir -p storage
  umask 077
  printf 'DATABASE_URL="file:%s/storage/proto.db"\nSESSION_SECRET=%s\nPORT=%s\nBASE_PATH=/proto\n' "$APP" "$(openssl rand -hex 32)" "$PORT" > .env
  ok ".env 만듦(비밀값은 이 파일에만 있어요. 공개 금지)"
fi

echo "▶ 4 DB(시제품 전용 SQLite: $APP/storage/proto.db, 운영 게임 DB와 별개)"
node --env-file=.env node_modules/prisma/build/index.js db push --schema server/prisma/schema.prisma --skip-generate

echo "▶ 5 서비스 gmm-proto (127.0.0.1:$PORT)"
if [ -z "$SKIP_SYSTEMD" ]; then
  sudo tee /etc/systemd/system/gmm-proto.service >/dev/null <<EOF
[Unit]
Description=GMM 방범대 시제품 ($HOST/proto)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP
ExecStart=$(command -v node) --env-file=$APP/.env --import tsx $APP/server/src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now gmm-proto
  sudo systemctl restart gmm-proto
fi
if [ -n "$SKIP_SYSTEMD" ]; then  # 리허설: 서비스 대신 직접 띄우고 끝나면 끔
  node --env-file="$APP/.env" --import tsx "$APP/server/src/main.ts" >"$APP/storage/rehearsal.log" 2>&1 & SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
fi
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/proto/api/v1/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/proto/api/v1/health" >/dev/null || die "서버가 응답하지 않아요: sudo journalctl -u gmm-proto -n 40 --no-pager"
ok "시제품 서버 응답(내부)"

echo "▶ 6 터널: $HOST/proto → 127.0.0.1:$PORT"
CONF="$CF/config.yml"
if [ ! -f "$CONF" ] || ! grep -q "hostname: $HOST" "$CONF"; then
  echo "⚠ $CONF 에서 $HOST 설정을 찾지 못했어요. 터널을 Cloudflare 화면에서 관리하는 방식일 수 있어요."
  echo "   Cloudflare → Zero Trust → Networks → Tunnels → gmm → Public hostname 추가:"
  echo "   Subdomain 비움, Domain $HOST, Path ^/proto(/.*)?\$ , Service HTTP 127.0.0.1:$PORT  (기존 항목보다 위에)"
  echo "   추가한 뒤 확인: curl -fsS https://$HOST/proto/api/v1/health"
  exit 0
fi
if grep -q "path: \^/proto" "$CONF"; then ok "이미 /proto 규칙이 있어요"
else
  BACKUP="$CONF.bak-proto-$(date +%Y%m%d-%H%M%S)"; cp "$CONF" "$BACKUP"; ok "설정 백업: $BACKUP"
  # 기존 '- hostname: HOST' 줄 바로 위에 /proto 규칙을 넣음(위에서부터 처음 맞는 규칙이 쓰이므로 다른 주소는 그대로 기존 서버로)
  node -e '
    const fs=require("fs"),[conf,host,port]=process.argv.slice(1);const lines=fs.readFileSync(conf,"utf8").split("\n");
    const i=lines.findIndex(l=>l.trim()==="- hostname: "+host);if(i<0)process.exit(2);
    const indent=lines[i].slice(0,lines[i].indexOf("-"));
    lines.splice(i,0,indent+"- hostname: "+host,indent+"  path: ^/proto(/.*)?$",indent+"  service: http://127.0.0.1:"+port);
    fs.writeFileSync(conf,lines.join("\n"));' "$CONF" "$HOST" "$PORT" || { cp "$BACKUP" "$CONF"; die "설정 파일 모양이 예상과 달라요. 바꾸지 않았어요."; }
  if command -v cloudflared >/dev/null; then
    if ! cloudflared tunnel --config "$CONF" ingress validate; then cp "$BACKUP" "$CONF"; die "새 설정이 검사를 통과하지 못해 백업으로 되돌렸어요."; fi
    echo "   규칙 확인:"; cloudflared tunnel --config "$CONF" ingress rule "https://$HOST/proto/" || true
    cloudflared tunnel --config "$CONF" ingress rule "https://$HOST/health" || true
  fi
  [ -z "$SKIP_SYSTEMD" ] && sudo systemctl restart gmm-named-tunnel
  ok "터널 규칙 추가"
fi

echo "▶ 7 주소 확인 (최대 60초)"
[ -n "$SKIP_SYSTEMD" ] && { ok "리허설: 바깥 주소 확인은 건너뜀"; exit 0; }
for i in $(seq 1 20); do
  if curl -fsS "https://$HOST/proto/api/v1/health" 2>/dev/null; then echo
    curl -fsS "https://$HOST/health" >/dev/null && ok "기존 게임 서버도 그대로 응답(https://$HOST/health)" || echo "⚠ 기존 게임 서버 응답 확인 실패 — README의 되돌리기를 보세요"
    ok "시제품: https://$HOST/proto/"
    echo "다음: 시험 계정 코드 발급 →  cd $APP && node --env-file=.env --import tsx tools/issue-codes.ts 내이름"
    exit 0
  fi; sleep 3
done
die "바깥 주소가 아직 응답하지 않아요. sudo systemctl status gmm-named-tunnel --no-pager | head -15"
