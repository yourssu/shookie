import type { ActiveMentionGroup, MentionGroupCatalog } from "./types.js";

const HANDLE_CANDIDATE_PATTERN = /@([A-Za-z][A-Za-z0-9_-]{1,31})/gu;
const RAW_URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>()]+/giu;
const EMAIL_PATTERN =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;

export interface MentionHandleOccurrence {
  handle: string;
  raw: string;
  start: number;
  end: number;
}

export interface MentionReplacementPlan {
  text: string;
  changed: boolean;
  matchedOccurrenceCount: number;
  groupHandles: string[];
  memberUserIds: string[];
  unknownHandles: string[];
  emptyGroupHandles: string[];
}

/**
 * Finds only plain-text @handles. Slack entities, code, links, URLs, email
 * addresses, and handles joined directly to another word are deliberately
 * excluded so a catalog entry cannot reinterpret unrelated user content.
 */
export function findMentionHandleOccurrences(text: string): MentionHandleOccurrence[] {
  const protectedOffsets = buildProtectedOffsets(text);
  const occurrences: MentionHandleOccurrence[] = [];

  for (const match of text.matchAll(HANDLE_CANDIDATE_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const captured = match[1];
    if (start === undefined || !raw || !captured) continue;
    const end = start + raw.length;
    if (hasProtectedOffset(protectedOffsets, start, end)) continue;

    const previous = start > 0 ? text[start - 1] : undefined;
    const next = end < text.length ? text[end] : undefined;
    if ((previous && isHandleWordCharacter(previous)) || previous === "@") continue;
    if (next && isHandleWordCharacter(next)) continue;

    occurrences.push({
      handle: captured.toLowerCase(),
      raw,
      start,
      end,
    });
  }

  return occurrences;
}

export function createMentionReplacementPlan(
  text: string,
  catalog: MentionGroupCatalog,
  occurrences = findMentionHandleOccurrences(text),
): MentionReplacementPlan {
  const uniqueMemberIds = new Set<string>();
  const seenGroups = new Set<string>();
  const unknownHandles = new Map<string, string>();
  const emptyGroupHandles = new Map<string, string>();
  const replacements: Array<MentionHandleOccurrence & { replacement: string }> = [];
  let matchedOccurrenceCount = 0;

  for (const occurrence of occurrences) {
    const group = catalog.byHandle.get(occurrence.handle);
    if (!group) {
      if (!unknownHandles.has(occurrence.handle)) {
        unknownHandles.set(occurrence.handle, occurrence.raw.slice(1));
      }
      continue;
    }

    matchedOccurrenceCount += 1;
    seenGroups.add(group.handle);
    if (group.memberUserIds.length === 0) {
      if (!emptyGroupHandles.has(group.handle)) {
        emptyGroupHandles.set(group.handle, occurrence.raw.slice(1));
      }
      continue;
    }

    const occurrenceMembers = [...new Set(group.memberUserIds)];
    for (const memberId of occurrenceMembers) uniqueMemberIds.add(memberId);
    const memberMentions = occurrenceMembers.map((memberId) => `<@${memberId}>`).join(" ");
    replacements.push({
      ...occurrence,
      replacement: memberMentions.length > 0
        ? `\`@${occurrence.handle}\`(${memberMentions})`
        : `\`@${occurrence.handle}\``,
    });
  }

  if (replacements.length === 0) {
    return {
      text,
      changed: false,
      matchedOccurrenceCount,
      groupHandles: [...seenGroups],
      memberUserIds: [...uniqueMemberIds],
      unknownHandles: [...unknownHandles.values()],
      emptyGroupHandles: [...emptyGroupHandles.values()],
    };
  }

  let cursor = 0;
  let output = "";
  for (const replacement of replacements) {
    output += text.slice(cursor, replacement.start);
    output += replacement.replacement;
    cursor = replacement.end;
  }
  output += text.slice(cursor);

  return {
    text: output,
    changed: output !== text,
    matchedOccurrenceCount,
    groupHandles: [...seenGroups],
    memberUserIds: [...uniqueMemberIds],
    unknownHandles: [...unknownHandles.values()],
    emptyGroupHandles: [...emptyGroupHandles.values()],
  };
}

export function buildMentionGroupIndex(
  groups: ActiveMentionGroup[],
): ReadonlyMap<string, ActiveMentionGroup> {
  const byHandle = new Map<string, ActiveMentionGroup>();
  for (const group of groups) {
    byHandle.set(group.handle, group);
    for (const alias of group.aliases) byHandle.set(alias, group);
  }
  return byHandle;
}

function buildProtectedOffsets(text: string): Uint8Array {
  const offsets = new Uint8Array(text.length);
  markBacktickSpans(text, offsets);
  markDelimitedSpans(text, offsets, "<", ">");
  markPatternSpans(text, offsets, RAW_URL_PATTERN);
  markPatternSpans(text, offsets, EMAIL_PATTERN);
  return offsets;
}

function markBacktickSpans(text: string, offsets: Uint8Array): void {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("`", cursor);
    if (open < 0) return;
    let runLength = 1;
    while (text[open + runLength] === "`") runLength += 1;
    const fence = "`".repeat(runLength);
    const close = text.indexOf(fence, open + runLength);
    if (close < 0) {
      markRange(offsets, open, text.length);
      return;
    }
    const end = close + runLength;
    markRange(offsets, open, end);
    cursor = end;
  }
}

function markDelimitedSpans(
  text: string,
  offsets: Uint8Array,
  openToken: string,
  closeToken: string,
): void {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(openToken, cursor);
    if (open < 0) return;
    const close = text.indexOf(closeToken, open + openToken.length);
    if (close < 0) {
      markRange(offsets, open, text.length);
      return;
    }
    const end = close + closeToken.length;
    markRange(offsets, open, end);
    cursor = end;
  }
}

function markPatternSpans(text: string, offsets: Uint8Array, pattern: RegExp): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    markRange(offsets, match.index, match.index + match[0].length);
  }
}

function markRange(offsets: Uint8Array, start: number, end: number): void {
  offsets.fill(1, start, end);
}

function hasProtectedOffset(offsets: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (offsets[index] === 1) return true;
  }
  return false;
}

function isHandleWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}_-]/u.test(value);
}
