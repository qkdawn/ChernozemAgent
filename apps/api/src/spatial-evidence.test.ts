import { describe, expect, it } from "vitest";
import { measureSpatialOverlap, observationInsideZone } from "./spatial-evidence.js";

const rectangle = (west: number, south: number, east: number, north: number) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const target = rectangle(123.8, 42.3, 123.84, 42.31);

describe("spatial evidence comparisons", () => {
  it("measures crossing polygons even when neither centroid is inside the other", () => {
    const overlap = measureSpatialOverlap(target, { resultId: "radar-result", zones: [{ id: "crossing", zone: rectangle(123.83, 42.29, 123.84, 42.35) }] });
    expect(overlap.status).toBe("computed");
    expect(overlap.overlapAreaHa).toBeGreaterThan(0);
    expect(overlap.overlapFraction).toBeCloseTo(0.25, 6);
    expect(overlap.contributingZoneIds).toEqual(["crossing"]);
  });

  it("unions source zones so duplicates cannot double-count overlap", () => {
    const overlap = measureSpatialOverlap(target, { resultId: "terrain-result", zones: [{ id: "one", zone: target }, { id: "two", zone: target }] });
    expect(overlap.overlapFraction).toBeCloseTo(1, 10);
    expect(overlap.overlapAreaHa).toBeCloseTo(overlap.geometryAreaHa!, 10);
    expect(overlap.contributingZoneIds).toEqual(["one", "two"]);
  });

  it.each([
    [],
    [{ id: "disjoint", zone: rectangle(124, 43, 125, 44) }],
    [{ id: "touching", zone: rectangle(123.84, 42.3, 123.85, 42.31) }],
  ].map((zones) => ({ zones })))("records a computed zero for empty, disjoint, or boundary-only source coverage", ({ zones }) => {
    expect(measureSpatialOverlap(target, { resultId: "radar-result", zones })).toMatchObject({ status: "computed", overlapAreaHa: 0, overlapFraction: 0, contributingZoneIds: [] });
  });

  it("keeps unavailable data separate from measured zero", () => {
    expect(measureSpatialOverlap(target, null)).toMatchObject({ status: "unavailable", sourceResultId: null, overlapAreaHa: null, overlapFraction: null });
  });

  it.each([
    [[123.8, 42.3]],
    [[123.8, 42.3], [123.84, 42.31], [123.8, 42.31], [123.84, 42.3], [123.8, 42.3]],
    [[NaN, 42.3], [123.84, 42.3], [123.84, 42.31], [NaN, 42.3]],
    rectangle(181, 42.3, 182, 42.31),
  ].map((invalid) => ({ invalid })))("rejects invalid geometry instead of declaring no overlap", ({ invalid }) => {
    expect(measureSpatialOverlap(invalid, { resultId: "radar-result", zones: [] })).toMatchObject({ status: "invalid_geometry", overlapAreaHa: null });
    expect(measureSpatialOverlap(target, { resultId: "radar-result", zones: [{ id: "bad", zone: invalid }] })).toMatchObject({ status: "invalid_geometry", overlapAreaHa: null });
  });

  it("includes boundary observations and preserves invalid inputs", () => {
    expect(observationInsideZone([123.8, 42.3], target)).toBe(true);
    expect(observationInsideZone([123.82, 42.305], target)).toBe(true);
    expect(observationInsideZone([123.85, 42.305], target)).toBe(false);
    expect(observationInsideZone([123.82, 42.305], [[123.8, 42.3]])).toBeNull();
    expect(observationInsideZone([NaN, 42.3], target)).toBeNull();
  });
});
