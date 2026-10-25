import { describe, expect, it } from "vitest";

import { routeAnalysisRequest } from "./analysis-request-router.js";

describe("analysis request router", () => {
  const field = { name: "一号田", crop: "corn" as const, seasonYear: 2026, plantingDate: "2026-05-05" };

  it("routes explicit anomalies without invoking a general agent", async () => {
    await expect(routeAnalysisRequest({ field, message: "昨天下大雨，看看田里有没有积水" }))
      .resolves.toEqual({ objective: "waterlogging_detection", period: "last_30_days" });
  });

  it("forces frost requests to the forecast window", async () => {
    await expect(routeAnalysisRequest({ field, message: "本季未来几天会不会霜冻", periodHint: "this_season" }))
      .resolves.toEqual({ objective: "frost_risk_warning", period: "last_30_days" });
  });
});
