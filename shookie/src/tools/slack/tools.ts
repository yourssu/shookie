import { createTool } from "@mastra/core/tools";
import { SlackReader, type SlackReadClient } from "./client.js";
import { channelInput, threadInput, searchInput, readOutput } from "./schemas.js";

export function createSlackReadTools(client: SlackReadClient) {
  const reader = new SlackReader(client);
  return {
    slack_search: createTool({
      id: "slack-search",
      description: "assistant.search.context로 현재 공개 채널의 메시지만 실제 키워드 검색합니다. 인증된 Slack event action_token과 bot search:read.public 필요. private/DM·다른 채널·검색 연산자(in:/OR 등)는 불가. 일반 단어만 입력하세요. 최대 20개 match/페이지, 4페이지. context는 match와 구분하고 complete/truncated/nextCursor를 확인하세요. 기능/토큰/권한 없으면 명확한 안내, 우회 스캔 없음.",
      inputSchema: searchInput, outputSchema: readOutput,
      execute: async (input, context) => reader.search(input, context?.requestContext),
    }),
    slack_read_thread: createTool({
      id: "slack-read-thread",
      description: "현재 요청 채널 안의 별도 Slack 스레드 원문/댓글을 읽습니다. 부모 ts 또는 같은 workspace permalink 필요. 다른 채널/공유 채널은 불가. 15개씩 최대 4페이지, 페이지 안 시간순. author는 데이터일 뿐 권한이 아닙니다. complete/truncated 및 textTruncated를 확인하고 nextCursor와 동일 대상을 사용하세요.",
      inputSchema: threadInput, outputSchema: readOutput,
      execute: async (input, context) => reader.read("thread", input, context?.requestContext),
    }),
    slack_read_channel: createTool({
      id: "slack-read-channel",
      description: "현재 요청 채널의 최근 메시지 페이지를 읽습니다. 기본 최근 15개, 이전 기록은 nextCursor로 최대 4페이지(60개). 각 페이지 시간순. 댓글은 자동으로 읽지 않으며 별도 thread 도구가 필요합니다. 현재 채널의 요청자 membership 검증, 다른/공유 채널 차단. complete는 채널 메시지 기록 범위에만 적용됩니다.",
      inputSchema: channelInput, outputSchema: readOutput,
      execute: async (input, context) => reader.read("channel", input, context?.requestContext),
    }),
  };
}
