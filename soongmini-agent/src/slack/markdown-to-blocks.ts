import type { KnownBlock } from "@slack/types";

export interface ConversionResult {
  blocks: KnownBlock[];
  fallbackText: string;
}

type ParsedBlock =
  | { type: "heading2"; text: string }
  | { type: "heading3"; text: string }
  | { type: "divider" }
  | { type: "table"; headerRow: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

const SECTION_TEXT_LIMIT = 3000;
const HEADER_TEXT_LIMIT = 150;
const MAX_BLOCKS = 50;

export function convertMarkdownToBlocks(responseText: string, debugFooter: string): ConversionResult {
  const parsed = parseMarkdown(responseText);
  const blocks = parsedBlocksToSlackBlocks(parsed);
  blocks.push(buildDebugContextBlock(debugFooter));
  const trimmed = enforceBlockLimit(blocks);
  const fallbackText = buildFallbackText(responseText, debugFooter);

  return { blocks: trimmed, fallbackText };
}

function parseMarkdown(text: string): ParsedBlock[] {
  const result: ParsedBlock[] = [];
  const lines = text.split("\n");

  let currentParagraph: string[] = [];
  let currentTable: string[][] = [];
  let inCodeBlock = false;
  let inTable = false;

  function flushParagraph() {
    const joined = currentParagraph.join("\n").trim();
    if (joined) {
      result.push({ type: "paragraph", text: joined });
    }
    currentParagraph = [];
  }

  function flushTable() {
    if (currentTable.length === 0) return;

    const headerRow = currentTable[0].map((c) => c.trim());
    const rows = currentTable.slice(1).filter((row) => !isSeparatorRow(row));
    if (rows.length > 0) {
      result.push({ type: "table", headerRow, rows: rows.map((r) => r.map((c) => c.trim())) });
    }
    currentTable = [];
    inTable = false;
  }

  for (const line of lines) {
    // Code block tracking
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        currentParagraph.push(line);
        inCodeBlock = false;
        continue;
      }
      flushParagraph();
      flushTable();
      currentParagraph.push(line);
      inCodeBlock = true;
      continue;
    }

    if (inCodeBlock) {
      currentParagraph.push(line);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}\s*$/.test(line)) {
      flushParagraph();
      flushTable();
      result.push({ type: "divider" });
      continue;
    }

    // Heading 2
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushParagraph();
      flushTable();
      result.push({ type: "heading2", text: h2[1].trim() });
      continue;
    }

    // Heading 3
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushParagraph();
      flushTable();
      result.push({ type: "heading3", text: h3[1].trim() });
      continue;
    }

    // Table row
    const tableMatch = line.match(/^\|(.+)\|$/);
    if (tableMatch) {
      if (!inTable) {
        flushParagraph();
        inTable = true;
        currentTable = [];
      }
      const cells = tableMatch[1].split("|");
      currentTable.push(cells);
      continue;
    }

    // Regular line — if we were in a table, flush it
    if (inTable) {
      flushTable();
    }

    currentParagraph.push(line);
  }

  flushParagraph();
  flushTable();

  return result;
}

function isSeparatorRow(row: string[]): boolean {
  return row.every((cell) => /^[-:\s]+$/.test(cell.trim()));
}

function parsedBlocksToSlackBlocks(parsed: ParsedBlock[]): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  for (const block of parsed) {
    switch (block.type) {
      case "heading2": {
        const text = stripMarkdownBold(block.text).slice(0, HEADER_TEXT_LIMIT);
        blocks.push({
          type: "header",
          text: { type: "plain_text", text, emoji: true },
        });
        break;
      }
      case "heading3": {
        const text = block.text;
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*${stripMarkdownBold(text)}*` },
        });
        break;
      }
      case "divider": {
        blocks.push({ type: "divider" });
        break;
      }
      case "table": {
        const mrkdwn = tableToMrkdwn(block.headerRow, block.rows);
        for (const chunk of splitLongText(mrkdwn)) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: chunk },
          });
        }
        break;
      }
      case "paragraph": {
        for (const chunk of splitLongText(block.text)) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: chunk },
          });
        }
        break;
      }
    }
  }

  return blocks;
}

function tableToMrkdwn(headerRow: string[], rows: string[][]): string {
  if (headerRow.length <= 2) {
    // Key-value format for 2-column tables
    return rows
      .map((row) => `• *${row[0] || ""}*: ${row[1] || "-"}`)
      .join("\n");
  }

  // Card-per-row format for 3+ columns
  return rows
    .map((row) => {
      const title = row[0] || "";
      const subtitle = row[1] || "";
      const rest = headerRow
        .slice(2)
        .map((h, i) => `${h}: ${row[i + 2] || "-"}`)
        .join(" | ");
      const line = `• *${stripMarkdownBold(title)}* — ${subtitle}`;
      return rest ? `${line}\n  ${rest}` : line;
    })
    .join("\n");
}

function buildDebugContextBlock(footer: string): KnownBlock {
  const lines = footer
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const text = lines.join(" | ");
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
}

function splitLongText(text: string): string[] {
  if (text.length <= SECTION_TEXT_LIMIT) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > SECTION_TEXT_LIMIT && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function enforceBlockLimit(blocks: KnownBlock[]): KnownBlock[] {
  if (blocks.length <= MAX_BLOCKS) return blocks;

  const contextBlock = blocks[blocks.length - 1];
  const truncated = blocks.slice(0, MAX_BLOCKS - 2);
  truncated.push({
    type: "section",
    text: { type: "mrkdwn", text: "... (응답이 너무 길어 일부가 생략되었습니다)" },
  });
  if (contextBlock) truncated.push(contextBlock);
  return truncated;
}

function buildFallbackText(responseText: string, debugFooter: string): string {
  let text = responseText
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^---+\s*$/gm, "")
    .replace(/^\|[-:|\s]+\|$/gm, "");
  return text + "\n" + debugFooter;
}

function stripMarkdownBold(text: string): string {
  return text.replace(/\*+/g, "");
}
