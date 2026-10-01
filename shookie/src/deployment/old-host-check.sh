#!/usr/bin/env bash
# Optional manual check: runs the real EC2 deploy script (git auth, flock, GNU tools) inside ubuntu:20.04,
# the same Git (2.25.1) the production host has, against a local Basic-auth git server.
# Docker/curl/sleep are mocks (the real docker is never touched). Usage: bash shookie/src/deployment/old-host-check.sh
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

exec docker run --rm --platform linux/arm64 -v "$repo_root:/repo:ro" ubuntu:20.04 bash -euo pipefail -c '
apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl python3 >/dev/null 2>&1
echo "== $(git --version), $(python3 --version), flock: $(command -v flock)"

work=$(mktemp -d); cd "$work"
M=/repo/shookie/src/deployment/mocks
export MOCK_STATE="$work/state"; mkdir -p "$MOCK_STATE" bin home projects/yourssu
for f in docker sleep; do cp "$M/$f" bin/; done; chmod +x bin/*   # real git and real flock are used
export HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 PATH="$work/bin:$PATH"

token="p@ss:w/rd\$'"'"'\"&;# \`x\` \\end"
printf "%s" "$token" > token
git init -q --bare projects/yourssu/shookie.git && git -C projects/yourssu/shookie.git symbolic-ref HEAD refs/heads/main
git init -q src && git -C src symbolic-ref HEAD refs/heads/main && cd src && git -c user.name=t -c user.email=t@e commit -q --allow-empty -m one
git push -q ../projects/yourssu/shookie.git main; sha=$(git rev-parse HEAD); cd ..
python3 "$M/git-auth-server.py" "$work/projects" x-access-token token port >/dev/null 2>&1 &
for _ in $(seq 100); do [ -s port ] && break; sleep 0.1; done; port=$(cat port)
printf "[url \"http://127.0.0.1:%s/\"]\n\tinsteadOf = https://github.com/\n" "$port" > "$HOME/.gitconfig"

# extract the ssh-action script block exactly as written in the workflow
awk "/^ +script: \\|\$/{f=1; match(\$0,/^ +/); ind=RLENGTH+2; next} f{ if (\$0 ~ /^ *\$/) {print \"\"; next} match(\$0,/^ */); if (RLENGTH<ind) exit; print substr(\$0, ind+1)}" /repo/.github/workflows/deploy.yml \
  | sed "s#/home/ubuntu#$work/home#g" > deploy.sh
test -s deploy.sh

echo "== negative control: Git 2.25 ignores GIT_CONFIG_COUNT/KEY/VALUE (the approach that failed on Radar)"
if GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $(printf "x-access-token:%s" "$token" | base64 -w0)" git ls-remote "http://127.0.0.1:$port/yourssu/shookie.git" >/dev/null 2>&1; then
  echo "UNEXPECTED: GIT_CONFIG_COUNT worked on this git"; exit 1
else echo "ok: GIT_CONFIG_COUNT auth is rejected (ignored) by this git"; fi

run() { # <token> -> runs deploy.sh, prints status
  env GIT_TOKEN="$1" GHCR_TOKEN=m GHCR_USER=m REPO_SLUG=yourssu/shookie DEPLOY_SHA="$sha" \
      IMAGE_PREFIX=ghcr.io/yourssu/shookie IMAGE_TAG=sha-0123456789ab bash deploy.sh
}
mkdir -p "$HOME/shookie-placeholder" && rmdir "$HOME/shookie-placeholder"

echo "== clone + deploy with special-character token"
run "$token" > out.log 2>&1 || { cat out.log; exit 1; }
[ "$(git -C "$HOME/shookie" rev-parse HEAD)" = "$sha" ]
echo "ok: clone authenticated, HEAD=$sha, flock acquired"

echo "== fetch path (existing checkout)"
git -C src -c user.name=t -c user.email=t@e commit -q --allow-empty -m two && git -C src push -q ../projects/yourssu/shookie.git main
sha=$(git -C src rev-parse HEAD)
run "$token" > out2.log 2>&1 || { cat out2.log; exit 1; }
[ "$(git -C "$HOME/shookie" rev-parse HEAD)" = "$sha" ]
echo "ok: fetch authenticated, HEAD=$sha"

echo "== no token left behind"
for frag in "$token" "p@ss" "w/rd"; do
  if grep -rqF -- "$frag" "$HOME/.gitconfig" "$HOME/shookie/.git/config" out.log out2.log; then echo "LEAK: $frag"; exit 1; fi
done
origin=$(git -C "$HOME/shookie" config --get remote.origin.url); echo "origin=$origin"; [ "$origin" = "https://github.com/yourssu/shookie.git" ]
ls -A "$HOME" | grep -q "shookie-git-askpass" && { echo "LEAK: askpass helper left"; exit 1; }
echo "ok: no token in gitconfig, remote URL, logs; askpass helper removed"

echo "== wrong token fails before docker pull/up"
rm -f "$MOCK_STATE/log"
if run wrong-token > out3.log 2>&1; then echo "UNEXPECTED success"; exit 1; fi
grep -q "git fetch failed" out3.log
! grep -qE "pull|compose up|login" "$MOCK_STATE/log" 2>/dev/null
echo "ok: rejected credentials abort before pull/up"

echo "== concurrent deploy is refused by real flock"
exec 9>"$HOME/.shookie-deploy.lock"; flock -n 9
if run "$token" > out4.log 2>&1; then echo "UNEXPECTED success under lock"; exit 1; fi
grep -q "Another deploy is already running" out4.log
echo "ok: second deploy refused while the lock is held"
echo "ALL OK"
'
