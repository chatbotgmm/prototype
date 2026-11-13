#!/usr/bin/env bash
# 시제품 업데이트: 받기 → 설치·빌드·시험 → DB 스키마 반영 → 재시작 → 확인. 시험이 실패하면 서비스를 바꾸지 않음.
#   sudo -iu ubuntu bash ~/proto/deploy/update.sh
set -euo pipefail
APP="${APP_DIR:-$HOME/proto}";cd "$APP"
PORT=$(node --env-file=.env -p 'process.env.PORT||3100')
SKIP_SYSTEMD="${SKIP_SYSTEMD:-}"   # 리허설용: 1이면 재시작을 건너뜀(이미 떠 있는 서버로 확인)
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
[ "$before" = "$after" ] && [ "${1:-}" != "-f" ] && { echo "새 커밋이 없어요(다시 설치하려면 -f)."; exit 0; }
npm ci --no-audit --no-fund
npx prisma generate --schema server/prisma/schema.prisma >/dev/null
npm run -s web:build
npm test --silent >/tmp/gmm-proto-test.log 2>&1 || { tail -30 /tmp/gmm-proto-test.log; git reset --hard "$before"; npm ci --no-audit --no-fund >/dev/null; npm run -s web:build; echo "❌ 시험 실패: 이전 코드($before)로 되돌렸어요. 서비스는 그대로예요."; exit 1; }
cp storage/proto.db "storage/proto.db.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
node --env-file=.env node_modules/prisma/build/index.js db push --schema server/prisma/schema.prisma --skip-generate
[ -z "$SKIP_SYSTEMD" ] && sudo systemctl restart gmm-proto
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/proto/api/v1/health" >/dev/null 2>&1 && { echo "✅ 업데이트 완료: $(git log -1 --format='%h %s')"; exit 0; }; sleep 1; done
echo "❌ 재시작 뒤 응답이 없어요: sudo journalctl -u gmm-proto -n 40 --no-pager"; exit 1
