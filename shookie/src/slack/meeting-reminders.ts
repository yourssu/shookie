import {
  claimMeetingReminder,
  markMeetingReminderAcked,
  markMeetingReminderDelivered,
  releaseUndeliveredMeetingReminder,
} from "database";
import type { App } from "@slack/bolt";
import { logger } from "../logger.js";

export interface MeetingReminderConfig {
  apiUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
}

interface DueReminder {
  occurrenceId: string;
  channelId: string;
  affiliationName: string;
  meetingTitle: string;
  startsAt: string;
  endsAt: string;
  isOnline: boolean;
  locationName?: string | null;
}

function parseReminders(payload: unknown): DueReminder[] {
  if (!Array.isArray(payload)) throw new Error("Radar returned an invalid due-reminders response");
  return payload.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Radar returned an invalid reminder");
    const value = item as Record<string, unknown>;
    const occurrenceId = value.occurrenceId ?? value.occurrence_id;
    const channelId = value.channelId ?? value.channel_id;
    const affiliation = value.affiliation && typeof value.affiliation === "object"
      ? value.affiliation as Record<string, unknown>
      : {};
    const team = value.team && typeof value.team === "object"
      ? value.team as Record<string, unknown>
      : {};
    const affiliationName = value.affiliationName ?? value.teamName ?? value.affiliation_name ?? affiliation.name ?? team.name;
    const meetingTitle = value.meetingTitle ?? value.title ?? value.meeting_title;
    const startsAt = value.startsAt ?? value.startAt ?? value.starts_at;
    const endsAt = value.endsAt ?? value.endAt ?? value.ends_at;
    const isOnline = value.isOnline ?? value.is_online;
    const locationName = value.locationName ?? value.location_name ?? value.location;
    if ([occurrenceId, channelId, affiliationName, meetingTitle, startsAt, endsAt].some((v) => typeof v !== "string" || !v.trim()) || typeof isOnline !== "boolean") {
      throw new Error("Radar returned a reminder with missing required fields");
    }
    if (!Number.isFinite(Date.parse(startsAt as string)) || !Number.isFinite(Date.parse(endsAt as string))) throw new Error("Radar returned an invalid reminder date");
    return { occurrenceId: occurrenceId as string, channelId: channelId as string, affiliationName: affiliationName as string,
      meetingTitle: meetingTitle as string, startsAt: startsAt as string, endsAt: endsAt as string, isOnline,
      locationName: typeof locationName === "string" ? locationName : null };
  });
}

function formatMessage(reminder: DueReminder): string {
  const date = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date(reminder.startsAt));
  const time = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(reminder.startsAt));
  const venue = reminder.isOnline ? "온라인" : `오프라인 · ${reminder.locationName?.trim() || "장소 미정"}`;
  return `📅 *${reminder.affiliationName}* 미팅 알림\n*${reminder.meetingTitle}*\n${date} ${time} (KST)\n진행 방식: ${venue}`;
}

async function request(config: MeetingReminderConfig, url: string, method = "GET"): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { method, headers: { Accept: "application/json", "X-Radar-Meeting-Reminder-Key": config.apiKey },
      redirect: "error", signal: controller.signal });
  } finally { clearTimeout(timeout); }
}

export async function pollMeetingRemindersOnce(app: App, config: MeetingReminderConfig): Promise<void> {
    try {
      const response = await request(config, `${config.apiUrl}/due`);
      if (!response.ok) throw new Error(`Radar due-reminders request failed (${response.status})`);
      const reminders = parseReminders(await response.json());
      for (const reminder of reminders) {
        try {
          const state = await claimMeetingReminder(reminder.occurrenceId, reminder.channelId);
          if (!state.delivered) {
            if (!state.claimed) {
              logger.warn("미팅 알림 claim은 있으나 게시 완료가 확인되지 않아 처리를 보류합니다", { occurrenceId: reminder.occurrenceId });
              continue;
            }
            try {
              const sent = await app.client.chat.postMessage({
                channel: reminder.channelId,
                text: formatMessage(reminder),
                mrkdwn: true,
                link_names: false,
              });
              await markMeetingReminderDelivered(reminder.occurrenceId, sent.ts ?? "");
            } catch (error) {
              await releaseUndeliveredMeetingReminder(reminder.occurrenceId);
              throw error;
            }
          }
          const ack = await request(config, `${config.apiUrl}/${encodeURIComponent(reminder.occurrenceId)}/ack`, "POST");
          if (!ack.ok) throw new Error(`Radar reminder acknowledgement failed (${ack.status})`);
          await ack.body?.cancel();
          await markMeetingReminderAcked(reminder.occurrenceId);
        } catch (error) {
          logger.error("미팅 알림을 처리하지 못했습니다", { occurrenceId: reminder.occurrenceId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      logger.error("Radar 미팅 알림 조회에 실패했습니다", { error: error instanceof Error ? error.message : String(error) });
    }
}

export function registerMeetingReminderScheduler(app: App, config: MeetingReminderConfig): void {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try { await pollMeetingRemindersOnce(app, config); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void poll(); }, 60_000);
  timer.unref();
  void poll();
}
