import type { AnalysisBrief } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { analysisBriefVisibleSections } from "./analysis-brief-presentation.js";

describe("analysis brief visible sections", () => {
  it("keeps overview and actions visible when a document is present", () => {
    const sections = analysisBriefVisibleSections(brief({ overview: "西南区域长势下降。", actions: [action], document }));

    expect(sections.showOverview).toBe(true);
    expect(sections.showActions).toBe(true);
    expect(sections.showDocument).toBe(true);
  });

  it("shows a document even without overview or actions", () => {
    const sections = analysisBriefVisibleSections(brief({ document }));

    expect(sections.showDocument).toBe(true);
    expect(sections.showOverview).toBe(false);
    expect(sections.showActions).toBe(false);
  });

  it("shows actions when no document is present", () => {
    const sections = analysisBriefVisibleSections(brief({ actions: [action] }));

    expect(sections.showActions).toBe(true);
    expect(sections.showDocument).toBe(false);
  });
});

function brief(overrides: Partial<AnalysisBrief> = {}): AnalysisBrief {
  return {
    version: "analysis-brief-v2", headline: "长势巡检", overview: "", reasoning: "", uncertainty: null,
    evidence: [], actions: [], generation: {
      mode: "deterministic", generatedAt: "2026-08-20T00:00:00.000Z", provider: null,
      modelId: null, promptVersion: null, fallbackReason: null,
    },
    ...overrides,
  };
}

const action: AnalysisBrief["actions"][number] = {
  label: "巡查西南区域", where: "西南区域", timing: "近期", checklist: [], decisionEffect: "若 A 则继续核查；若 B 则调整判断。",
};

const document: NonNullable<AnalysisBrief["document"]> = { title: "农情分析", subtitle: "长势巡检", sections: [] };
