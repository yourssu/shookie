import {
  claimMeetingReminder,
  markMeetingReminderAcked,
  markMeetingReminderDelivered,
  releaseUndeliveredMeetingReminder,
} from "database";
import type { App } from "@slack/bolt";
import { logger } from "../logger.js";
import type { MentionGroupCatalog } from "./mention-groups/types.js";

export interface MeetingReminderConfig {
  apiUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
}

interface DueReminder {
  occurrenceId: string;
  reminderId: string;
  reminderOffsetHours: 1 | 24;
  channelId: string;
  affiliationName: string;
  meetingTitle: string;
  startsAt: string;
  endsAt: string;
  isOnline: boolean;
  locationName?: string | null;
  mentionGroupHandle: string | null;
  mentionUserIds: string[];
}

export interface MeetingReminderMentionGroupCatalogProvider {
  getCatalog(): Promise<MentionGroupCatalog>;
}

function parseReminders(payload: unknown): DueReminder[] {
  if (!Array.isArray(payload)) throw new Error("Radar returned an invalid due-reminders response");
  return payload.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Radar returned an invalid reminder");
    const value = item as Record<string, unknown>;
    const occurrenceId = value.occurrenceId ?? value.occurrence_id;
    const reminderId = value.reminderId ?? value.reminder_id ?? occurrenceId;
    const reminderOffsetHours = value.reminderOffsetHours ?? value.reminder_offset_hours ?? 24;
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
    const mentionGroupHandle = value.mentionGroupHandle ?? value.mention_group_handle ?? null;
    const mentionUserIds = value.mentionUserIds ?? value.mention_user_ids ?? [];
    if ([occurrenceId, reminderId, channelId, affiliationName, meetingTitle, startsAt, endsAt].some((v) => typeof v !== "string" || !v.trim()) || typeof isOnline !== "boolean") {
      throw new Error("Radar returned a reminder with missing required fields");
    }
    if (reminderOffsetHours !== 1 && reminderOffsetHours !== 24) {
      throw new Error("Radar returned an invalid meeting reminder offset");
    }
    if (!Array.isArray(mentionUserIds) || mentionUserIds.some((id) => typeof id !== "string" || !/^[UW][A-Z0-9]{1,20}$/u.test(id))) {
      throw new Error("Radar returned invalid meeting reminder mention members");
    }
    if (mentionGroupHandle !== null && (typeof mentionGroupHandle !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/u.test(mentionGroupHandle))) {
      throw new Error("Radar returned an invalid meeting reminder mention group");
    }
    if (!Number.isFinite(Date.parse(startsAt as string)) || !Number.isFinite(Date.parse(endsAt as string))) throw new Error("Radar returned an invalid reminder date");
    return { occurrenceId: occurrenceId as string, reminderId: reminderId as string, reminderOffsetHours, channelId: channelId as string, affiliationName: affiliationName as string,
      meetingTitle: meetingTitle as string, startsAt: startsAt as string, endsAt: endsAt as string, isOnline,
      locationName: typeof locationName === "string" ? locationName : null,
      mentionGroupHandle: mentionGroupHandle as string | null,
      mentionUserIds: [...new Set(mentionUserIds as string[])] };
  });
}

function resolveMentionUserIds(reminder: DueReminder, catalog?: MentionGroupCatalog | null): string[] {
  const group = reminder.mentionGroupHandle ? catalog?.byHandle.get(reminder.mentionGroupHandle) : undefined;
  const memberUserIds = group?.memberUserIds.length ? group.memberUserIds : reminder.mentionUserIds;
  return [...new Set(memberUserIds)];
}

function formatMessage(reminder: DueReminder, catalog?: MentionGroupCatalog | null): string {
  const date = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date(reminder.startsAt));
  const time = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(reminder.startsAt));
  const venue = reminder.isOnline ? "온라인" : `오프라인 · ${reminder.locationName?.trim() || "장소 미정"}`;
  const mentions = resolveMentionUserIds(reminder, catalog).map((userId) => `<@${userId}>`).join(" ");
  const groupLabel = reminder.mentionGroupHandle
    ? `\`@${reminder.mentionGroupHandle}\`${mentions ? `(${mentions})` : ""}`
    : mentions;
  const timing = reminder.reminderOffsetHours === 1 ? "시작 1시간 전" : "시작 하루 전";
  return `${groupLabel ? `${groupLabel}\n` : ""}📅 *${reminder.affiliationName}* 미팅 알림 (${timing})\n*${reminder.meetingTitle}*\n${date} ${time} (KST)\n진행 방식: ${venue}`;
}

async function request(config: MeetingReminderConfig, url: string, method = "GET"): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { method, headers: { Accept: "application/json", "X-Radar-Meeting-Reminder-Key": config.apiKey },
      redirect: "error", signal: controller.signal });
  } finally { clearTimeout(timeout); }
}

export async function pollMeetingRemindersOnce(
  app: App,
  config: MeetingReminderConfig,
  mentionGroupCatalog?: MeetingReminderMentionGroupCatalogProvider,
): Promise<void> {
    try {
      const response = await request(config, `${config.apiUrl}/due`);
      if (!response.ok) throw new Error(`Radar due-reminders request failed (${response.status})`);
      const reminders = parseReminders(await response.json());
      let catalog: MentionGroupCatalog | null = null;
      if (mentionGroupCatalog && reminders.some((reminder) => reminder.mentionGroupHandle)) {
        try {
          catalog = await mentionGroupCatalog.getCatalog();
        } catch (error) {
          logger.warn("미팅 알림 멘션 그룹 조회 실패, Radar 응답 멤버를 사용합니다", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const reminder of reminders) {
        try {
          const state = await claimMeetingReminder(reminder.reminderId, reminder.channelId);
          if (!state.delivered) {
            if (!state.claimed) {
              logger.warn("미팅 알림 claim은 있으나 게시 완료가 확인되지 않아 처리를 보류합니다", { occurrenceId: reminder.occurrenceId, reminderId: reminder.reminderId });
              continue;
            }
            const mentionUserIds = resolveMentionUserIds(reminder, catalog);
            if (reminder.mentionGroupHandle && mentionUserIds.length === 0) {
              logger.warn("미팅 알림 멘션 그룹에 대상 멤버가 없습니다", {
                occurrenceId: reminder.occurrenceId,
                reminderId: reminder.reminderId,
                mentionGroupHandle: reminder.mentionGroupHandle,
              });
            } else if (!reminder.mentionGroupHandle && mentionUserIds.length === 0) {
              logger.warn("미팅 알림에 연결된 Radar 멘션 그룹이 없습니다", {
                occurrenceId: reminder.occurrenceId,
                reminderId: reminder.reminderId,
                affiliationName: reminder.affiliationName,
              });
            }
            try {
              const sent = await app.client.chat.postMessage({
                channel: reminder.channelId,
                text: formatMessage(reminder, catalog),
                mrkdwn: true,
                link_names: false,
              });
              await markMeetingReminderDelivered(reminder.reminderId, sent.ts ?? "");
            } catch (error) {
              await releaseUndeliveredMeetingReminder(reminder.reminderId);
              throw error;
            }
          }
          const ack = await request(config, `${config.apiUrl}/${encodeURIComponent(reminder.reminderId)}/ack`, "POST");
          if (!ack.ok) throw new Error(`Radar reminder acknowledgement failed (${ack.status})`);
          await ack.body?.cancel();
          await markMeetingReminderAcked(reminder.reminderId);
        } catch (error) {
          logger.error("미팅 알림을 처리하지 못했습니다", { occurrenceId: reminder.occurrenceId, reminderId: reminder.reminderId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      logger.error("Radar 미팅 알림 조회에 실패했습니다", { error: error instanceof Error ? error.message : String(error) });
    }
}

export function registerMeetingReminderScheduler(
  app: App,
  config: MeetingReminderConfig,
  mentionGroupCatalog?: MeetingReminderMentionGroupCatalogProvider,
): void {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try { await pollMeetingRemindersOnce(app, config, mentionGroupCatalog); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void poll(); }, 60_000);
  timer.unref();
  void poll();
}
