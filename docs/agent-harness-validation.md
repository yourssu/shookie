# 하네스 로컬 검증 기록

모든 검증은 로컬 mock/합성 provider/임시 git fixture다. Slack/DeepSeek/PostHog/GitHub live 인증, 운영 서버/DB 작업, 배포는 미실행이다. 생성 중 실시간 토큰 스트리밍은 미완료이며 이번 구현은 감독자 승인된 생성 후 buffered 청크 전달이다.

## 통과 (각 명령 60초 이하)

- `yarn workspace database build`
- `yarn workspace shookie build`
- `yarn workspace shookie test src/agent src/tools/code-explorer src/tools/posthog --exclude '**/repository-snapshots.test.ts' --maxWorkers=2 --minWorkers=1 --reporter=dot`: 21 files / 352 tests
- `yarn workspace shookie test src/tools/code-explorer/repository-snapshots.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`: 1 file / 15 tests
- `yarn workspace shookie test src/slack src/cancellation src/services --maxWorkers=2 --minWorkers=1 --reporter=dot`: 42 files / 446 tests 통과, PostgreSQL outbox 1 file / 22 tests 기존 환경 미설정 skip
- `yarn workspace shookie test src/tools/attachments src/tools/images src/tools/slack src/tools/web src/security src/config.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 26 files / 810 tests
- `yarn workspace shookie test src/deployment/deploy-contract.test.ts src/deployment/git-auth.test.ts src/deployment/verify-image-arch.test.ts src/deployment/test-helpers.test.ts src/logger.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 5 files / 36 tests (배포 실제 실행 아님)

총 분할 검증: 95 files / 1,659 tests 통과 + 1 file / 22 tests skip. 배포 script 전체 파일은 아래 제한으로 완료하지 못했다.

## 실패/제한도 보존

- 초기 build는 database dist 미생성 상태로 module resolution 실패. database build 후 shookie build 통과.
- 초기 영향 테스트는 변경 전 위임/지침/plan/footer 계약 기대값 때문에 실패했다. 새로운 직접 도구·빈 지침·final-only 계약으로 갱신하고 기존 권한·철회·원문 비노출 검사는 유지했다.
- repository-snapshots 실제 로컬 git fixture는 묶음/직렬 실행 중 서로 다른 clone에서 간헐적 `controlled clone failed`를 보였다. 단독 실행은 15/15 통과(반복 확인). 원인 확정/런타임 우회/보안 assertion 완화는 하지 않았다. 이 간헐 실패는 남은 검증 위험이다.
- `yarn workspace shookie test src/deployment src/logger.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`는 command 60초 제한으로 종료되어 전체 deploy-script 결과를 얻지 못했다. 위의 별도 배포 계약 파일은 통과했다. 배포 script 코드 변경 없음.
- 정적 prompt/입력 테스트는 간결성이나 실제 모델의 후속 대상 해석 정확도를 보장하지 않는다. Slack markdown incremental 최종 UI와 feedback 렌더링도 문서 계약/모의 호출 검사만 했으며 live 화면 증거가 아니다.
