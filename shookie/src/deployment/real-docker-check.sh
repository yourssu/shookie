#!/usr/bin/env bash
# Optional manual check: runs the real EC2 deploy script against REAL docker/compose in an isolated sandbox
# (unique compose project, network, volume and image names; the real shookie/Radar resources are never touched).
# The bot image is replaced by tiny fake images that behave like a ready / crashing / never-ready bot, and the
# shared PostgreSQL is a throwaway copy of docker-compose.db.yml. git, flock and the GHCR login/pull are shims.
# Usage: bash shookie/src/deployment/real-docker-check.sh
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp="$(mktemp -d)"
P="shookie-e2e-$$"
PREFIX="ghcr.io/yourssu-e2e/shookie-$$"
port=$((39000 + RANDOM % 900))
home="$tmp/home"; mkdir -p "$home/shookie" "$tmp/bin"
log="$tmp/docker-calls.log"; : > "$log"

cleanup() {
  set +e
  ( cd "$home/shookie" && COMPOSE_FILE= docker compose -f docker-compose.db.yml down -v >/dev/null 2>&1 )
  docker ps -aq --filter "label=com.docker.compose.project=$P" | xargs docker rm -f >/dev/null 2>&1
  docker network rm "${P}_default" >/dev/null 2>&1
  docker volume rm "${P}_pgdata" >/dev/null 2>&1
  { docker image ls "$PREFIX" --format '{{.Repository}}:{{.Tag}}'; docker image ls "${P}-rollback/bot" --format '{{.Repository}}:{{.Tag}}'; } | xargs docker rmi >/dev/null 2>&1
  docker rmi "$P-fake:good-a" "$P-fake:good-b" "$P-fake:crash" "$P-fake:noready" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

# --- sandbox copies of the compose files (names isolated) ---
sed -e "s/^name: shookie\$/name: $P/" -e "s/name: shookie_default/name: ${P}_default/" "$repo_root/docker-compose.yml" > "$home/shookie/docker-compose.yml"
cp "$repo_root/docker-compose.deploy.yml" "$home/shookie/"
grep -v -e '127.0.0.1:5432:5432' -e '^    ports:' -e 'docker-entrypoint-initdb.d' "$repo_root/docker-compose.db.yml" \
  | sed -e "s/^name: shookie\$/name: $P/" -e "s/name: shookie_default/name: ${P}_default/" -e "s/name: shookie_pgdata/name: ${P}_pgdata/" > "$home/shookie/docker-compose.db.yml"

# --- fake bot images: a ready bot (prints the real start log line), a crashing bot, a never-ready bot ---
# images are created >1s apart so that "newest first" retention ordering (creation time) is unambiguous
build_fake() { sleep 1.2; printf 'FROM ubuntu:20.04\nLABEL e2e=%s\nCMD ["bash","-c","%s"]\n' "$2" "$3" | docker build -q -t "$P-fake:$1" - >/dev/null; }
build_fake good-a a 'echo \"2026-01-01T00:00:00.000Z [INFO] 슈키가 시작되었습니다! 🚀\"; exec sleep 3600'
build_fake good-b b 'echo \"2026-01-01T00:00:00.000Z [INFO] 슈키가 시작되었습니다! 🚀\"; exec sleep 3600'
build_fake crash c 'echo boom >&2; exit 1'
build_fake noready d 'echo booting; exec sleep 3600'
tag_as() { docker tag "$P-fake:$1" "$PREFIX:sha-$2"; }

# --- shims: record every docker call; fake GHCR login/pull; no real git/flock needed ---
real_docker="$(command -v docker)"
cat > "$tmp/bin/docker" <<SHIM
#!/usr/bin/env bash
echo "docker \$*" >> "$log"
case "\$1" in
  login) cat >/dev/null; exit 0 ;;
  pull) "$real_docker" image inspect "\$2" >/dev/null 2>&1 || { echo "pull access denied for \$2" >&2; exit 1; }; exit 0 ;;
esac
exec "$real_docker" "\$@"
SHIM
printf '#!/usr/bin/env bash\ncase "$1" in clone) mkdir -p "${3:-shookie}";; esac\nexit 0\n' > "$tmp/bin/git"
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/flock"
chmod +x "$tmp"/bin/*

# --- the real deploy script, extracted from the workflow, with sandbox paths and shorter waits ---
awk '/^ +script: \|$/{f=1; match($0,/^ +/); ind=RLENGTH+2; next} f{ if ($0 ~ /^ *$/) {print ""; next} match($0,/^ */); if (RLENGTH<ind) exit; print substr($0, ind+1)}' "$repo_root/.github/workflows/deploy.yml" \
  | sed -e "s#/home/ubuntu#$home#g" -e "s#shookie-rollback/bot#${P}-rollback/bot#" \
        -e 's/^READY_ATTEMPTS=36/READY_ATTEMPTS=5/' -e 's/^READY_INTERVAL=5/READY_INTERVAL=2/' -e 's/^STABLE_SECONDS=10/STABLE_SECONDS=4/' > "$tmp/deploy.sh"

deploy() { # <tag-suffix>
  env -i PATH="$tmp/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin" HOME="$HOME" \
    GIT_TOKEN=m GHCR_TOKEN=m GHCR_USER=m REPO_SLUG=yourssu/shookie DEPLOY_SHA=0123456789abcdef \
    IMAGE_PREFIX="$PREFIX" IMAGE_TAG="sha-$1" DEPLOY_SLACK_USER_OAUTH_PORT="$port" \
    DEPLOY_SLACK_BOT_TOKEN=xoxb-e2e DEPLOY_SLACK_APP_TOKEN=xapp-e2e DEPLOY_LLM_API_KEY=k DEPLOY_POSTGRES_PASSWORD=pw \
    bash "$tmp/deploy.sh"
}
bot_image_id() { docker inspect --format '{{.Image}}' "$(cd "$home/shookie" && COMPOSE_FILE=docker-compose.yml:docker-compose.deploy.yml SHOOKIE_BOT_IMAGE=x docker compose ps -a -q bot 2>/dev/null)"; }
fake_id() { docker image inspect --format '{{.Id}}' "$P-fake:$1"; }
db_identity() { local id; id="$(cd "$home/shookie" && docker compose -f docker-compose.db.yml ps -q db)"; echo "$id $(docker inspect --format '{{.State.StartedAt}}' "$id")"; }
expect_out() { printf "%s\n" "$out" | grep -E "$1" || { echo "ASSERTION FAILED: output lacks /$1/. Full output:" >&2; printf "%s\n" "$out" >&2; exit 1; }; }
expect() { if ! "$@"; then echo "ASSERTION FAILED: $*" >&2; exit 1; fi; }

echo "== start throwaway shared DB (sandbox copy of docker-compose.db.yml, project $P)"
( cd "$home/shookie" && POSTGRES_PASSWORD=pw docker compose -f docker-compose.db.yml up -d >/dev/null )
for _ in $(seq 1 60); do [ "$(docker inspect --format '{{.State.Health.Status}}' "$(cd "$home/shookie" && docker compose -f docker-compose.db.yml ps -q db)")" = healthy ] && break; sleep 2; done
DB_BEFORE="$(db_identity)"; echo "db identity: $DB_BEFORE"
: > "$log"   # only deploy-time docker calls are audited from here on

echo "== 1. first deploy (no bot container yet)"
tag_as good-a 00000000000a
out="$(deploy 00000000000a 2>&1)" || { echo "$out"; exit 1; }
expect_out "first deploy|Shookie bot is ready"
expect test "$(bot_image_id)" = "$(fake_id good-a)"
expect test ! -e "$home/.shookie-rollback-snapshot"

echo "== 2. second deploy (healthy bot -> snapshot, replace)"
tag_as good-b 00000000000b
out="$(deploy 00000000000b 2>&1)" || { echo "$out"; exit 1; }
expect_out "Rollback snapshot|Shookie bot is ready"
expect test "$(bot_image_id)" = "$(fake_id good-b)"
snap="$(cat "$home/.shookie-rollback-snapshot")"
expect test "$(docker image inspect --format '{{.Id}}' "${P}-rollback/bot:$snap")" = "$(fake_id good-a)"

tag_as crash 00000000000c
echo "== 3. crashing release -> automatic rollback to the previous image, deploy fails"
if out="$(deploy 00000000000c 2>&1)"; then echo "UNEXPECTED success"; exit 1; fi
expect_out "not running cleanly|did not become ready|Rollback succeeded"
expect test "$(bot_image_id)" = "$(fake_id good-b)"

tag_as noready 00000000000d
echo "== 4. never-ready release (stays running, no start log) -> rollback, deploy fails"
if out="$(deploy 00000000000d 2>&1)"; then echo "UNEXPECTED success"; exit 1; fi
expect_out "did not report Slack Socket Mode readiness|Rollback succeeded"
expect test "$(bot_image_id)" = "$(fake_id good-b)"

echo "== 5. pull failure (image missing in registry) -> bot untouched"
if out="$(deploy 0000000000ff 2>&1)"; then echo "UNEXPECTED success"; exit 1; fi
expect_out "pull access denied"
expect test "$(bot_image_id)" = "$(fake_id good-b)"

echo "== shared DB identity must be unchanged, and the deploy must never have run destructive commands"
expect test "$(db_identity)" = "$DB_BEFORE"
! grep -E "compose( -f [^ ]+)* (down|build|stop|rm|restart|create)|prune|volume|network|--build" "$log" || { echo "forbidden docker command found"; exit 1; }
grep -E "docker compose up" "$log" | grep -vq -- "--no-build --no-deps bot" && { echo "compose up without --no-build --no-deps"; exit 1; }
echo "db identity unchanged: $(db_identity)"
echo "ALL OK"
