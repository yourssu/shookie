import type { App } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  claimMeetingReminder: vi.fn(),
  markMeetingReminderAcked: vi.fn(),
  markMeetingReminderDelivered: vi.fn(),
  releaseUndeliveredMeetingReminder: vi.fn(),
}));

vi.mock("database", () => db);
vi.mock("../logger.js", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

import { pollMeetingRemindersOnce } from "./meeting-reminders.js";

const config = { apiUrl: "http://localhost:8080/internal/v1/meeting-reminders", apiKey: "local-key", requestTimeoutMs: 1000 };
const reminder = {
  occurrenceId: "meeting-1:2026-10-01T10:00:00+09:00",
  channelId: "C123",
  affiliationName: "Marketing",
  meetingTitle: "주간 회의",
  startsAt: "2026-10-01T10:00:00+09:00",
  endsAt: "2026-10-01T11:00:00+09:00",
  isOnline: false,
  locationName: "동방(학생회관 244호)",
};

const postMessage = vi.fn();
const app = { client: { chat: { postMessage } } } as unknown as App;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [reminder] })
    .mockResolvedValueOnce({ ok: true, body: { cancel: vi.fn() } }));
  db.claimMeetingReminder.mockResolvedValue({ claimed: true, delivered: false });
  postMessage.mockResolvedValue({ ts: "123.456" });
});

describe("meeting reminder polling", () => {
  it("posts a due reminder to the mapped channel and acknowledges it", async () => {
    await pollMeetingRemindersOnce(app, config);

    expect(db.claimMeetingReminder).toHaveBeenCalledWith(reminder.occurrenceId, "C123");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123", mrkdwn: true, link_names: false,
      text: expect.stringContaining("주간 회의"),
    }));
    expect(postMessage.mock.calls[0][0].text).toContain("동방(학생회관 244호)");
    expect(db.markMeetingReminderDelivered).toHaveBeenCalledWith(reminder.occurrenceId, "123.456");
    expect(fetch).toHaveBeenNthCalledWith(2, `${config.apiUrl}/${encodeURIComponent(reminder.occurrenceId)}/ack`,
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Radar-Meeting-Reminder-Key": "local-key" }) }));
    expect(db.markMeetingReminderAcked).toHaveBeenCalledWith(reminder.occurrenceId);
  });

  it("acknowledges an already delivered reminder without posting twice", async () => {
    db.claimMeetingReminder.mockResolvedValue({ claimed: false, delivered: true });
    await pollMeetingRemindersOnce(app, config);

    expect(postMessage).not.toHaveBeenCalled();
    expect(db.markMeetingReminderAcked).toHaveBeenCalledWith(reminder.occurrenceId);
  });

  it("releases a failed Slack send and leaves the reminder unacknowledged", async () => {
    postMessage.mockRejectedValue(new Error("Slack unavailable"));
    await pollMeetingRemindersOnce(app, config);

    expect(db.releaseUndeliveredMeetingReminder).toHaveBeenCalledWith(reminder.occurrenceId);
    expect(db.markMeetingReminderDelivered).not.toHaveBeenCalled();
    expect(db.markMeetingReminderAcked).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an active claim that is not delivered", async () => {
    db.claimMeetingReminder.mockResolvedValue({ claimed: false, delivered: false });
    await pollMeetingRemindersOnce(app, config);

    expect(postMessage).not.toHaveBeenCalled();
    expect(db.markMeetingReminderAcked).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
