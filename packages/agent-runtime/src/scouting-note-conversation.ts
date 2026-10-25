import type { ConversationScoutingNoteDraft, Position } from "@chernozem/contracts";

const RECORD_INTENT = /(?:记录|记下|记一下|保存|存一下).{0,18}(?:巡田|现场|田里|地里|地块|墒情|叶色|叶片|病虫)|(?:巡田|现场).{0,18}(?:记录|记下|记一下|保存|存一下)/;

export function parseConversationScoutingNote(message: string, today: string): Omit<ConversationScoutingNoteDraft, "fieldId"> | null {
  if (!RECORD_INTENT.test(message)) return null;
  const location = parseCoordinates(message);
  return {
    tool: "record_scouting_note",
    status: "draft",
    observedAt: observationDate(message, today),
    location,
    waterCondition: waterCondition(message),
    leafColor: leafColor(message),
    diseaseOrPest: diseaseOrPest(message),
    note: cleanNote(message),
    missingInputs: location ? [] : ["现场位置"],
    requiresConfirmation: true,
  };
}

function observationDate(message: string, today: string): string {
  const explicit = message.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicit && isCalendarDate(explicit)) return explicit;
  const offset = message.includes("前天") ? -2 : message.includes("昨天") ? -1 : 0;
  return shiftCalendarDate(today, offset);
}

function waterCondition(message: string): ConversationScoutingNoteDraft["waterCondition"] {
  if (/有积水|见积水|积着水|明水/.test(message)) return "standing_water";
  if (/偏湿|过湿|湿涝|土壤湿|墒情湿/.test(message)) return "wet";
  if (/偏干|过干|干旱|土壤干|墒情干/.test(message)) return "dry";
  if (/墒情正常|水分正常|土壤湿度正常/.test(message)) return "normal";
  return "unknown";
}

function leafColor(message: string): ConversationScoutingNoteDraft["leafColor"] {
  if (/叶(?:片|色)?.{0,5}(?:偏黄|发黄|浅黄)|黄叶/.test(message)) return "pale";
  if (/叶(?:片|色)?.{0,5}(?:深绿|浓绿)/.test(message)) return "dark_green";
  if (/叶色正常|叶片颜色正常/.test(message)) return "normal";
  return "unknown";
}

function diseaseOrPest(message: string): ConversationScoutingNoteDraft["diseaseOrPest"] {
  if (/(?:未见|没见|没有|无).{0,4}(?:病虫|虫害|病害)/.test(message)) return "none_seen";
  if (/(?:疑似|发现|看见|有).{0,4}(?:病虫|虫害|病害)|虫咬|病斑/.test(message)) return "suspected";
  return "unknown";
}

function parseCoordinates(message: string): Position | null {
  const match = message.match(/(?:经纬度|坐标)?\s*([+-]?\d{2,3}(?:\.\d+)?)\s*[,，、\s]\s*([+-]?\d{1,2}(?:\.\d+)?)/);
  if (!match) return null;
  const longitude = Number(match[1]);
  const latitude = Number(match[2]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
    ? { longitude, latitude }
    : null;
}

function cleanNote(message: string): string {
  return message
    .replace(/^\s*(?:请|帮我|麻烦)?\s*(?:记录|记下|记一下|保存|存一下)(?:一条|这条)?(?:巡田|现场)?(?:记录)?[：:,，]?\s*/, "")
    .trim()
    .slice(0, 500);
}

function shiftCalendarDate(value: string, offsetDays: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}
