# Slack 행사 참석 반응

Shookie는 Slack 반응 이벤트를 Radar 내부 API로 전달합니다. 행사와 멤버별 참석 상태의 원본 데이터는 Radar가 관리합니다. Radar 일정에서 Slack 연동을 켜고 대상 메시지 링크를 등록한 행사만 반영됩니다.

## 이모지 파일

Slack의 사용자 설정에서 다음 PNG를 사용자 지정 이모지로 추가합니다. 파일은 128×128, 투명 배경이며 Slack 업로드용 이름을 그대로 사용합니다.

| Slack 이름 | 파일 | 의미 |
|---|---|---|
| `shookie_attend` | `shookie/assets/event-emojis/shookie_attend.png` | `YOURSSU GO` |
| `shookie_absent` | `shookie/assets/event-emojis/shookie_absent.png` | `ABSENCE` |
| `shookie_afterparty` | `shookie/assets/event-emojis/shookie_afterparty.png` | 뒷풀이 |

Slack에서 `워크스페이스 이름 → 도구 및 설정 → 워크스페이스 사용자 지정 → 이모지`를 열고 파일을 올린 뒤, 표의 이름으로 저장합니다. 이모지 추가가 제한되어 있으면 워크스페이스 관리자에게 업로드를 요청합니다.

## 앱 설정

이 이벤트 이름은 `OAuth & Permissions`의 scope 목록에는 나타나지 않습니다. 그곳에는 `reactions:read`만 추가하고, 이벤트는 Slack API의 Shookie 앱 설정에서 따로 구독합니다.

1. `api.slack.com/apps`에서 Shookie 앱을 열고 `Features → Event Subscriptions`로 이동합니다.
2. `Enable Events`를 켜고 `Subscribe to bot events`에서 `reaction_added`와 `reaction_removed`를 추가합니다. Shookie는 Socket Mode를 사용하므로 Request URL은 설정하지 않습니다.
3. `OAuth & Permissions → Bot Token Scopes`에 `reactions:read`를 추가합니다.
4. 변경사항을 저장하고 Shookie를 Yourssu 워크스페이스에 다시 설치해 새 scope를 승인합니다.

매니페스트로 설정하려면 [`slack-event-attendance-manifest.yml`](./slack-event-attendance-manifest.yml)의 항목을 기존 매니페스트에 병합합니다. Slack은 `reaction_added`와 `reaction_removed` 구독에 `reactions:read` scope가 필요하다고 명시합니다. [reaction_added 이벤트](https://docs.slack.dev/reference/events/reaction_added/) · [Events API 설정](https://docs.slack.dev/apis/events-api/)

환경변수 예시:

```dotenv
SLACK_EVENT_ATTENDANCE_ENABLED=true
SLACK_EVENT_ATTENDING_EMOJI=shookie_attend
SLACK_EVENT_ABSENT_EMOJI=shookie_absent
SLACK_EVENT_AFTERPARTY_EMOJI=shookie_afterparty
RADAR_EVENT_ATTENDANCE_WRITE_API_URL=https://radar.example.com/internal/v1/events/slack-reactions
SHOOKIE_EVENT_ATTENDANCE_WRITE_API_KEY=<Radar backend와 동일한 전용 내부 write key>
RADAR_EVENT_ATTENDANCE_REQUEST_TIMEOUT_MS=10000
```

`RADAR_EVENT_ATTENDANCE_WRITE_API_URL`은 Radar backend에서 접근 가능한 주소여야 합니다. `SHOOKIE_EVENT_ATTENDANCE_WRITE_API_KEY`와 Radar backend의 `RADAR_EVENT_ATTENDANCE_INTERNAL_WRITE_API_KEY`에 같은 값을 설정합니다. 채널 allowlist는 필요하지 않습니다. Radar가 행사에 연결된 메시지인지, 해당 행사의 Slack 연동이 켜져 있는지 확인합니다.

Radar 일정에서 Slack 연동을 켠 뒤 Slack 메시지의 `더 보기 → 링크 복사`로 복사한 permalink를 붙여 넣습니다. 메시지에 반응을 달면 Shookie가 참석/불참/뒷풀이 변경 이벤트를 API에 보내고, Radar가 Slack User ID를 기존 멤버 연결과 매칭합니다. 미연결 사용자나 행사에 연결되지 않은 메시지는 행사 참석 데이터로 저장하지 않습니다. 같은 Slack 이벤트가 다시 전달되더라도 Radar가 중복 반영하지 않습니다.

Slack 앱은 Socket Mode를 사용하므로 Request URL은 설정하지 않습니다. 앱의 Bot Token Scopes에 `reactions:read`를 추가하고, Bot Events에 `reaction_added`와 `reaction_removed`를 추가한 다음 앱을 다시 설치해 scope 변경을 승인합니다.

행사 종료 24시간 후 Radar가 해당 일정의 Slack 반응 연동을 자동으로 끕니다. 이후 반응은 기존 일정 참석 현황에 추가되지 않습니다. 뒷풀이 입금 여부는 Radar 일정의 뒷풀이 리스트에서 운영자가 수동으로 체크하며, 계좌 연결이나 거래 내역 자동 조회·매칭은 하지 않습니다.
