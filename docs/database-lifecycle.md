# Shookie 공유 PostgreSQL 생명주기 런북

## 배포 계약

Shookie bot과 공유 PostgreSQL은 서로 다른 Compose 파일로 관리한다.

| 대상 | Compose 파일 | 일반 앱 배포에서의 동작 |
|---|---|---|
| Shookie bot | `docker-compose.yml` | 빌드하고 `--no-deps`로 교체 |
| 공유 PostgreSQL | `docker-compose.db.yml` | 상태만 확인하고 변경하지 않음 |
| 공유 네트워크 | `shookie_default` | DB Compose가 소유하고 앱 Compose는 external로 사용 |
| DB 볼륨 | `shookie_pgdata` | DB Compose에서만 참조 |

DB 서비스 이름과 네트워크 별칭은 계속 `db`다. 따라서 `shookie_default`에 연결된 Shookie와 Radar는 모두 기존 `db:5432` 주소를 사용한다. 기존 운영 리소스 이름인 `shookie-db-1`, `shookie_default`, `shookie_pgdata`도 유지된다.

일반 배포는 DB 컨테이너가 실행 중이고 healthy인지 먼저 확인한 뒤 bot만 빌드하고 교체한다. DB가 없거나 unhealthy하면 DB를 자동 생성 또는 재시작하지 않고 배포를 중단한다. DB 시작, 업그레이드, 재시작, 복구는 별도 변경 창과 백업 승인을 거쳐 `docker-compose.db.yml`로만 수행한다.

## 새 환경 초기화

다음 순서는 새 환경이나 명시적으로 승인된 DB 복구에만 사용한다. 기존 운영 DB에 일반 배포 절차로 실행하지 않는다.

```bash
docker compose -f docker-compose.db.yml config --quiet
docker compose -f docker-compose.db.yml up -d
docker compose -f docker-compose.db.yml exec -T db pg_isready -U postgres -d shookie
docker compose config --quiet
docker compose up -d --no-deps bot
```

실제 `POSTGRES_PASSWORD`는 승인된 secret 전달 경로에서 환경변수로 주입한다. 명령 인자, 셸 추적, 문서, 티켓, 로그에 값을 기록하지 않는다.

## 일반 앱 배포 전후 검증

배포 직전 DB container ID와 시작 시각을 운영 기록에 남긴다. 이 값은 secret이 아니다.

```bash
DB_ID_BEFORE="$(docker compose -f docker-compose.db.yml ps -q db)"
test -n "$DB_ID_BEFORE"
DB_STARTED_BEFORE="$(docker inspect --format '{{.State.StartedAt}}' "$DB_ID_BEFORE")"
test "$(docker inspect --format '{{.State.Health.Status}}' "$DB_ID_BEFORE")" = healthy
docker compose -f docker-compose.db.yml exec -T db pg_isready -U postgres -d shookie
```

GitHub Actions 배포가 끝난 뒤 같은 호스트에서 다시 확인한다.

```bash
DB_ID_AFTER="$(docker compose -f docker-compose.db.yml ps -q db)"
DB_STARTED_AFTER="$(docker inspect --format '{{.State.StartedAt}}' "$DB_ID_AFTER")"
test "$DB_ID_BEFORE" = "$DB_ID_AFTER"
test "$DB_STARTED_BEFORE" = "$DB_STARTED_AFTER"
test "$(docker inspect --format '{{.State.Health.Status}}' "$DB_ID_AFTER")" = healthy
docker compose -f docker-compose.db.yml exec -T db pg_isready -U postgres -d shookie
test "$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -q bot)")" = true
```

ID와 `StartedAt`이 모두 같으면 앱 재배포 중 DB 컨테이너가 교체되거나 재시작되지 않은 것이다. workflow도 같은 검사를 수행하며 불일치하면 배포를 실패로 처리한다.

## Shookie와 Radar 연결 확인

먼저 두 애플리케이션 컨테이너가 공유 네트워크에 연결됐고 `db` 별칭이 해석되는지 확인한다. `<radar-container>`에는 승인된 운영 인벤토리에서 확인한 실제 Radar 컨테이너 이름 또는 ID를 넣는다.

```bash
docker network inspect shookie_default --format '{{range .Containers}}{{println .Name}}{{end}}'
docker compose exec -T bot node -e 'require("node:dns").lookup("db", (error, address) => { if (error) throw error; console.log(address) })'
docker exec <radar-container> getent hosts db
```

그다음 Shookie와 Radar 각각의 기존 DB health check 또는 안전한 `SELECT 1` probe를 실행하고 정상 응답을 확인한다. 애플리케이션에 probe가 없다면 해당 컨테이너 내부에 이미 주입된 DB 환경을 사용하는 명령만 사용하며 DSN이나 비밀번호를 출력하지 않는다. 마지막으로 배포 시각 전후 로그에서 Shookie의 DB 연결/마이그레이션 성공과 Radar의 DB 연결 오류 부재를 확인하되 `docker inspect`로 환경변수를 출력하거나 셸 추적(`set -x`)을 켜지 않는다.

## 앱 롤백

1. 실패한 배포 SHA, 직전 정상 SHA, 위의 DB ID와 `StartedAt`을 기록한다.
2. `main`에 실패 변경을 revert하는 PR을 병합해 일반 배포 workflow를 다시 실행한다. 긴급 절차가 필요하면 승인된 운영자가 직전 정상 SHA를 체크아웃해 bot 이미지만 다시 빌드하고 `docker compose up -d --no-deps bot`으로 교체한다.
3. 롤백 전후 DB ID와 `StartedAt`이 같은지 위 절차로 다시 비교한다.
4. Shookie와 Radar의 `db` DNS, DB probe, 애플리케이션 핵심 health check를 확인한다.

앱 롤백은 스키마, DB 컨테이너, 네트워크 또는 볼륨 롤백을 포함하지 않는다. `docker compose down`, `docker compose -f docker-compose.db.yml down`, `docker compose up db`, `docker volume rm`, `down -v`를 사용하지 않는다. 새 애플리케이션이 적용한 스키마가 이전 버전과 호환되지 않는다면 DB를 임의로 되돌리지 말고 배포를 중단한 뒤 별도 복구 계획과 백업 승인을 받는다.

## 정적 검증

비밀값 대신 로컬 전용 더미 값을 사용한다.

```bash
POSTGRES_PASSWORD=validation-only docker compose config --quiet
POSTGRES_PASSWORD=validation-only docker compose -f docker-compose.db.yml config --quiet
actionlint .github/workflows/deploy.yml
```

`actionlint`가 설치되어 있지 않으면 프로젝트에 바이너리를 커밋하지 말고 공식 배포본을 임시 경로에 설치하거나, 최소한 YAML parser로 파일을 읽은 뒤 PR CI의 `actionlint` 결과를 확인한다.
