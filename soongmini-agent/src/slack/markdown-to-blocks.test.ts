import { describe, expect, it } from "vitest";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";

describe("convertMarkdownToBlocks", () => {
  it("converts plain text to a single section block", () => {
    const { blocks, fallbackText } = convertMarkdownToBlocks("Hello world", "🔧 도구: 없음");
    expect(blocks).toHaveLength(2); // section + context
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Hello world" },
    });
    expect(fallbackText).toContain("Hello world");
  });

  it("converts ## heading to header block", () => {
    const { blocks } = convertMarkdownToBlocks("## :octopus: PR 분석", "footer");
    const header = blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();
    expect(header).toEqual({
      type: "header",
      text: { type: "plain_text", text: ":octopus: PR 분석", emoji: true },
    });
  });

  it("converts ### heading to bold section block", () => {
    const { blocks } = convertMarkdownToBlocks("### :clipboard: 요약", "footer");
    const section = blocks[0];
    expect(section.type).toBe("section");
    if (section.type === "section" && "text" in section) {
      expect(section.text).toEqual({
        type: "mrkdwn",
        text: "*:clipboard: 요약*",
      });
    }
  });

  it("converts --- to divider block", () => {
    const { blocks } = convertMarkdownToBlocks("before\n---\nafter", "footer");
    expect(blocks.some((b) => b.type === "divider")).toBe(true);
  });

  it("converts markdown table to bullet list", () => {
    const markdown = [
      "| PR | 제목 | 상태 |",
      "|---|---|---|",
      "| #133 | fix: bug | Merged |",
      "| #132 | feat: new | Open |",
    ].join("\n");

    const { blocks } = convertMarkdownToBlocks(markdown, "footer");
    const section = blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section" && "text" in section) {
      const text = section.text as { type: string; text: string };
      expect(text.text).toContain("*#133*");
      expect(text.text).toContain("fix: bug");
      expect(text.text).toContain("Merged");
    }
  });

  it("converts 2-column table to key-value format", () => {
    const markdown = ["| 항목 | 값 |", "|---|---|", "| 이름 | 테스트 |"].join("\n");
    const { blocks } = convertMarkdownToBlocks(markdown, "footer");
    const section = blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section" && "text" in section) {
      const text = section.text as { type: string; text: string };
      expect(text.text).toContain("*이름*: 테스트");
    }
  });

  it("preserves code blocks verbatim", () => {
    const markdown = "```\n## not a heading\n---\n```";
    const { blocks } = convertMarkdownToBlocks(markdown, "footer");
    const section = blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section" && "text" in section) {
      const text = section.text as { type: string; text: string };
      expect(text.text).toContain("## not a heading");
      expect(text.text).toContain("---");
    }
    expect(blocks.some((b) => b.type === "header")).toBe(false);
    expect(blocks.some((b) => b.type === "divider")).toBe(false);
  });

  it("puts debug footer in context block", () => {
    const { blocks } = convertMarkdownToBlocks("text", "🔧 도구: github\n💰 토큰: 100");
    const context = blocks.find((b) => b.type === "context");
    expect(context).toBeDefined();
    if (context && context.type === "context" && "elements" in context) {
      const elements = context.elements as Array<{ type: string; text: string }>;
      expect(elements[0].text).toContain("🔧");
      expect(elements[0].text).toContain("💰");
    }
  });

  it("handles mixed content (realistic response)", () => {
    const markdown = [
      "## :octopus: PR 분석",
      "",
      ":warning: 최근 PR이 없어요.",
      "",
      "---",
      "",
      "### :clipboard: PR 요약",
      "",
      "| PR | 제목 | 상태 | 작성자 |",
      "|---|---|---|---|",
      "| **#133** | fix: bug | Merged | PeraSite |",
      "",
      "---",
      "",
      "### :mag: 주요 내용",
      "",
      "- **#133** 버그 수정",
    ].join("\n");

    const { blocks, fallbackText } = convertMarkdownToBlocks(markdown, "footer");

    expect(blocks.some((b) => b.type === "header")).toBe(true);
    expect(blocks.some((b) => b.type === "divider")).toBe(true);
    expect(fallbackText).not.toContain("## ");
    expect(fallbackText).toContain("PR 분석");
  });

  it("strips ## and --- from fallback text", () => {
    const { fallbackText } = convertMarkdownToBlocks("## Title\n---\nBody text", "footer");
    expect(fallbackText).not.toContain("## ");
    expect(fallbackText).not.toMatch(/^---$/m);
    expect(fallbackText).toContain("Title");
    expect(fallbackText).toContain("Body text");
  });

  it("handles empty input gracefully", () => {
    const { blocks } = convertMarkdownToBlocks("", "footer");
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("splits long text into multiple sections", () => {
    const longText = Array(200).fill("Lorem ipsum dolor sit amet consectetur adipiscing elit").join("\n\n");
    const { blocks } = convertMarkdownToBlocks(longText, "footer");
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
  });

  it("preserves bold and emoji shortcodes", () => {
    const { blocks } = convertMarkdownToBlocks("**bold** and :white_check_mark:", "footer");
    const section = blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section" && "text" in section) {
      const text = section.text as { type: string; text: string };
      expect(text.text).toContain("*bold*");
      expect(text.text).toContain(":white_check_mark:");
      expect(text.text).not.toContain("**bold**");
    }
  });

  it("converts **bold** to Slack *bold* in paragraphs and tables", () => {
    const markdown = "**SSUTime-Prod** 분석 결과입니다.";
    const { blocks } = convertMarkdownToBlocks(markdown, "footer");
    const section = blocks.find((b) => b.type === "section");
    if (section && section.type === "section" && "text" in section) {
      const text = section.text as { type: string; text: string };
      expect(text.text).toContain("*SSUTime-Prod*");
      expect(text.text).not.toContain("**SSUTime-Prod**");
    }
  });
});
