export const ssutimePostHogProjectId = "440922";

export const ssutimePostHogKnowledge = `
## SSUTime (슈타임) 도메인 지식

### 서비스 개요
SSU-Time(슈타임) — 숭실대학교 시간표/공강 관리 모바일 앱. 주요 기능: 시간표 관리, 과제 추적, 공강 알림(전화 알림), 홈 화면 위젯. Android/iOS 지원.

### 사용자 식별자 (User Schema)
아래 이벤트/속성 설명은 저장소에 등록된 도메인 명세이며 현재 운영 데이터로 재검증한 사실이 아니다. 앱 버전/프로젝트 설정에 따라 달라질 수 있다.
- **person_id**: PostHog 내부 사용자 ID. 식별/병합에 따라 사용자 집계 결과가 달라질 수 있으므로 생애 불변 ID라고 가정하지 않는다.
- **distinct_id**: 익명/식별 사용자 ID. 로그인 전에는 익명 ID, 로그인 성공(\`login_success\`) 이후부터는 학번을 SHA-256 hex 해시한 값이 \`distinct_id\`로 설정되어 사용자를 식별할 수 있음
- **$identify 이벤트**: 익명 → 식별 사용자 병합 지점. 회원가입/로그인 시점에 발생

### 사용자 속성 (주요, 이벤트 기준)
- **디바이스**: \`$device_model\`, \`$device_name\`, \`$device_manufacturer\`, \`$device_type\`
- **OS**: \`$os\`, \`$os_version\`, \`$os_name\`
- **앱**: \`$app_version\`, \`$app_build\`, \`$app_name\`, \`$app_namespace\`
- **환경**: \`$locale\`, \`$geoip_country_name\`, \`$geoip_city_name\`, \`$network_wifi\`, \`$network_cellular\`

> 기존 명세는 person-on-events 모드를 가정한다. 실제 프로젝트 설정과 속성 조회 의미를 확인해야 하며 person.properties가 항상 현재값 또는 수집 시점 값이라고 단정하지 않는다. 이벤트 속성은 이벤트마다 다를 수 있다.

### 주요 이벤트 (Event Spec)

**인증**
- \`view_login\`: 로그인 화면 진입
- \`login_attempt\`: 로그인 시도
- \`login_success\`: 로그인 성공
- \`login_fail\`: 로그인 실패
- \`kakao_click\`: 카카오 로그인 버튼 클릭 (주요 진입 경로)
- \`logout_click\` / \`logout_confirm\` / \`logout_cancel\`: 로그아웃 플로우

**화면 조회**
- \`view_home\`: 홈 화면 진입
- \`view_mypage\`: 마이페이지 진입
- \`$screen\`: PostHog 자동 화면 전환 추적

**과제 (Task)**
- \`task_detail_expand\` / \`task_detail_collapse\`: 과제 상세 펼치기/접기
- \`todo_snapshot\`: 할 일 스냅샷 (크롤링 이벤트 — 사용자 액션이 아닌 자동 발생 이벤트)
- \`submit_complete_click\`: 제출 완료 클릭

**홈 화면 위젯**
- \`widget_display\`: 위젯 표시 (**Android 전용**)
- \`widget_tap\` / \`widget_refresh_tap\`: 위젯 탭/새로고침
- \`widget_banner_click\` / \`widget_banner_confirm\` / \`widget_banner_dismiss\`: 위젯 배너 상호작용

**알림**
- \`notification_received\` / \`notification_tap\`: 일반 푸시 알림
- \`call_alert_received\` / \`call_alert_accept\` / \`call_alert_reject\`: 전화 알림 — 공강 알림 (**Android 전용**, iOS에는 해당 기능 없음. iOS 분석 시 제외)
- \`call_alarm_setting\`: 통화 알람 설정 진입 (**Android 전용**). Android 온보딩 마지막 단계이며, 앱 최초 실행 시에만 발생
- \`alarm_permission\`: 알람 권한 요청 (**iOS 온보딩 마지막 단계**, 앱 최초 실행 시에만 발생)
- \`setting_system_alarm\` / \`setting_call_alarm\`: 알람 설정 화면 진입. \`setting_call_alarm\`은 **Android 전용**

**앱스토어 / 설치**
- \`app_store_redirect\`: 앱스토어로 이동
- \`app_store_installed\`: 앱스토어 설치 완료 (**Android 전용**, iOS는 전송 안 함). UTM 파라미터(\`utm_source\`, \`utm_medium\`, \`utm_content\`)를 포함하며, 어떤 UTM 경로로 앱 설치까지 도달했는지 확인하는 용도
- \`Application Installed\` / \`Application Opened\`: PostHog 자동 수집

**새로고침**
- \`refresh_click\`, \`pull_to_refresh\`

### 신규 유저 정의 (권장)
- **정의**: 보유한 전체 이벤트 이력에서 person_id별 최초 시각(\`min(timestamp)\`)이 타겟 KST 구간에 속하는 사용자. 회원가입/설치 수나 기간 내 최초 방문 수와는 다르다.
- **한계**: 보존 기간/수집 시작 이전 이벤트는 알 수 없으며 식별 병합도 결과에 영향을 준다. 따라서 실제 생애 최초가 아닌 '사용 가능한 이력 기준 최초'다. 아래는 2026-01-02 KST 하루의 템플릿이며 live HogQL 실행 검증은 하지 않았다.
- **권장 쿼리**:
\`\`\`sql
SELECT toDate(toTimeZone(first_seen, 'Asia/Seoul')) AS date, count() AS new_users
FROM (
  SELECT person_id, min(timestamp) AS first_seen
  FROM events
  GROUP BY person_id
)
WHERE first_seen >= toDateTime('2026-01-01 15:00:00', 'UTC')
  AND first_seen < toDateTime('2026-01-02 15:00:00', 'UTC')
GROUP BY date
ORDER BY date
LIMIT 100
\`\`\`
- 최초 이벤트 분석은 events를 사용한다. persons 집계의 지원 여부/실패 원인은 별도 확인하며 일괄 금지 또는 안전 보장을 하지 않는다. 기간/이벤트 필터를 내부 쿼리에 추가하면 지표 정의가 달라진다.

### 비즈니스 컨텍스트
- **시즌성**: 학기 시작(개학), 중간/기말고사, 수강신청 기간에 트래픽 폭발. 방학 중에는 급감.
- **공강 알림(\`call_alert_*\`)**: Android 전용 기능. 학기 중에만 활발. 핵심 차별화 기능.
- **위젯 설치 베이스**: 헤비 유저의 proxy 후보 (\`widget_display\` 빈도로 검증 필요)
- **카카오 로그인(\`kakao_click\`)**: 신규 유저 진입 경로 후보이며 기존 사용자의 로그인도 포함할 수 있음
- **타임존**: KST(Asia/Seoul). 쿼리 시 \`timestamp + INTERVAL 9 HOUR\` 또는 \`toTimeZone(timestamp, 'Asia/Seoul')\` 권장.

### HogQL 쿼리 팁
- 이벤트 기반 지표는 events 기준. persons 쿼리 지원은 실제 스키마/설정에 따라 확인한다.
- 사용자 수 카운트: \`uniqExact(person_id)\` (정확) 또는 \`countDistinct(person_id)\`.
- 시간대 변환: \`toTimeZone(timestamp, 'Asia/Seoul')\` 후 \`toDate()\`.
- **DAU/유저 리텐션 계산 시 주의**: \`todo_snapshot\` 이벤트는 크롤링으로 자동 발생하는 이벤트이므로, DAU(Daily Active Users)나 유저 리텐션(User Retention) 지표에서 반드시 제외해야 함. 예: \`WHERE event != 'todo_snapshot'\`.
`.trim();
