import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { describe, expect, it } from "vitest";

import { summarizeGrowthZoneChange, type OpticalConditionPayload, type OpticalZoneSnapshot } from "./analysis-tools.js";
import { compareRelativeZoneCoverage, measureSpatialOverlap, observationInsideZone } from "./spatial-evidence.js";

const rectangle = (west: number, south: number, east: number, north: number) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const whole = rectangle(123.8, 42.3, 123.84, 42.31);
const left = rectangle(123.8, 42.3, 123.82, 42.31);
const right = rectangle(123.82, 42.3, 123.84, 42.31);
const hole = rectangle(123.81, 42.302, 123.83, 42.308);
const hectares = (ring: number[][]) => area(polygon([ring])) / 10_000;
type Zone = OpticalConditionPayload["zones"][number];
function zone(id: string, geometry = whole, classification: Zone["class"] = "below_average"): Zone {
  return { id, zone: geometry, holes: [], class: classification, row: 0, column: 0, meanNdvi: 0.6, deviation: -0.1, validPixelCount: 20, areaHa: 2 };
}
const snapshot = (observationDate: string, zones: Zone[]): OpticalZoneSnapshot => ({ observationDate, zones });

describe("same-location relative growth comparisons", () => {
  it("compares polygon coverage rather than equal component IDs or nearby centroids", () => {
    const result = summarizeGrowthZoneChange([
      snapshot("2026-07-21", [zone("same-id", left), zone("normal-before", right, "near_average")]),
      snapshot("2026-07-31", [zone("same-id", right), zone("normal-after", left, "near_average")]),
    ], "2026-07-31");
    expect(result.status).toBe("computed");
    expect(result.areas!.belowOnBothDatesHa).toBe(0);
    expect(result.areas!.newlyBelowWithinCommonHa).toBeCloseTo(hectares(right), 7);
    expect(result.areas!.noLongerBelowWithinCommonHa).toBeCloseTo(hectares(left), 7);
    expect(result.currentBelowZones[0]!.previousBelowZoneIds).toEqual([]);
    expect(result).not.toHaveProperty("matchedZoneCount");
  });

  it("keeps overlapping locations comparable after component reindexing or centroid changes", () => {
    const before = zone("old-id");
    const after = { ...zone("new-id"), row: 999, column: 999 };
    const result = compareRelativeZoneCoverage([before], [after]);
    expect(result.status).toBe("computed");
    expect(result.areas!.belowOnBothDatesHa).toBeCloseTo(hectares(whole), 7);
    expect(result.areas!.newlyBelowWithinCommonHa).toBe(0);
    expect(result.currentBelowZones[0]!.previousBelowZoneIds).toEqual(["old-id"]);
  });

  it("sorts dates and chooses the nearest strictly earlier date, excluding future snapshots", () => {
    const result = summarizeGrowthZoneChange([
      snapshot("2026-08-05", [zone("future")]), snapshot("2026-07-31", [zone("current")]),
      snapshot("2026-07-16", [zone("older", right)]), snapshot("2026-07-21", [zone("prior", left)]),
    ], "2026-07-31");
    expect(result).toMatchObject({ status: "computed", fromDate: "2026-07-21", toDate: "2026-07-31" });
    expect(result.currentBelowZones[0]!.previousBelowZoneIds).toEqual(["prior"]);
  });

  it("does not substitute another observation for a missing current snapshot", () => {
    const result = summarizeGrowthZoneChange([snapshot("2026-07-21", [zone("prior")]), snapshot("2026-08-05", [zone("future")])], "2026-07-31");
    expect(result).toMatchObject({ status: "not_comparable", reason: "missing_current_snapshot", currentBelowZoneCount: null, currentBelowAreaHa: null, areas: null });
  });

  it("keeps missing previous coverage distinct from a measured zero", () => {
    const result = summarizeGrowthZoneChange([snapshot("2026-07-31", [zone("current")])], "2026-07-31");
    expect(result).toMatchObject({ status: "not_comparable", reason: "missing_previous_snapshot", previousBelowZoneCount: null, previousBelowAreaHa: null, fromDate: null, areas: null });
  });

  it("rejects ambiguous duplicate dates and empty classified footprints", () => {
    const prior = snapshot("2026-07-21", [zone("prior")]);
    const current = snapshot("2026-07-31", [zone("current")]);
    expect(summarizeGrowthZoneChange([prior, current, current], "2026-07-31")).toMatchObject({ status: "not_comparable", reason: "ambiguous_snapshot_date" });
    expect(summarizeGrowthZoneChange([prior, prior, current], "2026-07-31")).toMatchObject({ status: "not_comparable", reason: "ambiguous_snapshot_date" });
    expect(summarizeGrowthZoneChange([prior, snapshot("2026-07-31", [])], "2026-07-31")).toMatchObject({ status: "not_comparable", reason: "empty_observed_coverage" });
  });

  it("ignores nonexistent calendar dates when selecting a baseline", () => {
    expect(summarizeGrowthZoneChange([snapshot("2026-02-30", [zone("invalid")]), snapshot("2026-03-03", [zone("current")])], "2026-03-03")).toMatchObject({ status: "not_comparable", reason: "missing_previous_snapshot" });
  });

  it("does not label previously unobserved weak areas as new", () => {
    const result = compareRelativeZoneCoverage([zone("prior", left, "near_average")], [zone("current", right)]);
    expect(result.areas).toMatchObject({ commonObservedHa: 0, belowOnBothDatesHa: 0, newlyBelowWithinCommonHa: 0, noLongerBelowWithinCommonHa: 0 });
    expect(result.areas!.currentBelowUnobservedPreviouslyHa).toBeCloseTo(hectares(right), 7);
  });

  it("does not turn a new cloud hole into recovery of the previous weak region", () => {
    const result = compareRelativeZoneCoverage([zone("prior", hole)], [{ ...zone("current", whole, "near_average"), holes: [hole] }]);
    expect(result.status).toBe("computed");
    expect(result.areas!.noLongerBelowWithinCommonHa).toBe(0);
    expect(result.areas!.previousBelowUnobservedCurrentlyHa).toBeCloseTo(hectares(hole), 7);
  });

  it("does not turn a previously cloudy region into a newly weak region", () => {
    const result = compareRelativeZoneCoverage([{ ...zone("prior", whole, "near_average"), holes: [hole] }], [zone("current", hole)]);
    expect(result.status).toBe("computed");
    expect(result.areas!.newlyBelowWithinCommonHa).toBe(0);
    expect(result.areas!.currentBelowUnobservedPreviouslyHa).toBeCloseTo(hectares(hole), 7);
  });

  it("distinguishes a relative class transition from an actual NDVI decline", () => {
    const prior = { ...zone("prior", whole, "near_average"), meanNdvi: 0.5 };
    const current = { ...zone("current"), meanNdvi: 0.7 };
    const result = compareRelativeZoneCoverage([prior], [current]);
    expect(result.areas!.newlyBelowWithinCommonHa).toBeCloseTo(hectares(whole), 7);
    expect(result).not.toHaveProperty("ndviDelta");
    expect(result).not.toHaveProperty("trend");
  });

  it("does not double-count repeated polygons or split components", () => {
    const result = compareRelativeZoneCoverage([zone("one"), zone("duplicate")], [zone("left", left), zone("right", right)]);
    expect(result.areas!.belowOnBothDatesHa).toBeCloseTo(hectares(whole), 7);
    expect(result.areas!.commonObservedHa).toBeCloseTo(hectares(whole), 7);
    expect(result.areas!.newlyBelowWithinCommonHa).toBeCloseTo(0, 9);
  });

  it("preserves measured zero for an observed field without weak regions", () => {
    const result = compareRelativeZoneCoverage([zone("prior", whole, "near_average")], [zone("current", whole, "above_average")]);
    expect(result.status).toBe("computed");
    expect(result.areas!.commonObservedHa).toBeGreaterThan(0);
    expect(result.areas!.belowOnBothDatesHa).toBe(0);
    expect(result.currentBelowZones).toEqual([]);
  });

  it("does not reinterpret exterior-only saved zones as complete observed coverage", () => {
    const old = zone("old"); delete old.holes;
    expect(compareRelativeZoneCoverage([old], [zone("current")])).toMatchObject({ status: "incomplete_geometry", areas: null, currentBelowZones: [] });
  });

  it("preserves missing valid-pixel areas while allowing independently measured footprint overlaps", () => {
    const missing = zone("missing"); delete missing.areaHa;
    const result = summarizeGrowthZoneChange([snapshot("2026-07-21", [missing]), snapshot("2026-07-31", [zone("current")])], "2026-07-31");
    expect(result).toMatchObject({ status: "computed", previousBelowAreaHa: null, currentBelowAreaHa: 2 });
    expect(result.areas!.belowOnBothDatesHa).toBeCloseTo(hectares(whole), 7);
  });

  it.each([rectangle(181, 42, 182, 43), [[123.8, 42.3]], [[123.8, 42.3], [123.84, 42.31], [123.8, 42.31], [123.84, 42.3], [123.8, 42.3]]].map((invalid) => ({ invalid })))("returns invalid geometry instead of a false zero", ({ invalid }) => {
    expect(compareRelativeZoneCoverage([zone("prior")], [zone("invalid", invalid)])).toMatchObject({ status: "invalid_geometry", areas: null });
  });

  it("rejects holes outside their outer polygon", () => {
    expect(compareRelativeZoneCoverage([zone("prior")], [{ ...zone("current"), holes: [rectangle(124, 42.3, 124.01, 42.31)] }])).toMatchObject({ status: "invalid_geometry", areas: null });
  });

  it("uses holes in both multi-source overlaps and field-observation locations", () => {
    const source = { resultId: "inside-gap", zones: [{ id: "gap", zone: hole }] };
    expect(measureSpatialOverlap(whole, source, [hole])).toMatchObject({ status: "computed", overlapAreaHa: 0, overlapFraction: 0 });
    expect(measureSpatialOverlap(hole, { resultId: "source-gap", zones: [{ id: "shell", zone: whole, holes: [hole] }] })).toMatchObject({ status: "computed", overlapAreaHa: 0 });
    expect(observationInsideZone([123.82, 42.305], whole, [hole])).toBe(false);
    expect(observationInsideZone([123.805, 42.305], whole, [hole])).toBe(true);
  });
});
