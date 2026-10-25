import { describe, expect, it } from "vitest";

import { parseConversationScoutingNote } from "./scouting-note-conversation.js";

describe("parseConversationScoutingNote", () => {
  it("extracts a candidate field observation without saving it", () => {
    expect(parseConversationScoutingNote("记一下，昨天田里叶色偏黄、墒情偏干，未见病虫害", "2026-08-26")).toEqual({
      tool: "record_scouting_note",
      status: "draft",
      observedAt: "2026-08-25",
      location: null,
      waterCondition: "dry",
      leafColor: "pale",
      diseaseOrPest: "none_seen",
      note: "昨天田里叶色偏黄、墒情偏干，未见病虫害",
      missingInputs: ["现场位置"],
      requiresConfirmation: true,
    });
  });

  it("keeps an explicit coordinate for later field-scope validation", () => {
    expect(parseConversationScoutingNote("保存现场记录：2026-08-20 坐标 123.805, 42.305，有积水和疑似虫害", "2026-08-26")).toMatchObject({
      observedAt: "2026-08-20",
      location: { longitude: 123.805, latitude: 42.305 },
      waterCondition: "standing_water",
      diseaseOrPest: "suspected",
      missingInputs: [],
    });
  });

  it("does not turn analysis or general discussion into a write candidate", () => {
    expect(parseConversationScoutingNote("帮我分析这块地有没有积水", "2026-08-26")).toBeNull();
    expect(parseConversationScoutingNote("玉米叶片发黄通常是什么原因？", "2026-08-26")).toBeNull();
  });
});
