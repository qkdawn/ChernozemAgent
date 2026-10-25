import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import union from "@turf/union";

export interface SpatialOverlap {
  sourceResultId: string | null;
  status: "computed" | "unavailable" | "invalid_geometry" | "calculation_failed";
  geometryAreaHa: number | null;
  overlapAreaHa: number | null;
  overlapFraction: number | null;
  contributingZoneIds: string[];
}

interface ZoneFootprint {
  id: string;
  zone: number[][];
  holes?: number[][][];
}

export interface RelativeZoneCoverageChange {
  status: "computed" | "incomplete_geometry" | "invalid_geometry" | "calculation_failed";
  /** Geodesic footprint areas, distinct from valid-pixel area estimates. */
  areas: {
    previousObservedHa: number;
    currentObservedHa: number;
    commonObservedHa: number;
    belowOnBothDatesHa: number;
    newlyBelowWithinCommonHa: number;
    noLongerBelowWithinCommonHa: number;
    currentBelowUnobservedPreviouslyHa: number;
    previousBelowUnobservedCurrentlyHa: number;
  } | null;
  currentBelowZones: Array<{
    id: string;
    previouslyObservedHa: number;
    belowOnBothDatesHa: number;
    newlyBelowWithinCommonHa: number;
    unobservedPreviouslyHa: number;
    previousBelowZoneIds: string[];
  }>;
}

/** WGS84 polygon footprints; areas here are geodesic, not valid-pixel areas. */
export function measureSpatialOverlap(
  ring: number[][],
  source: { resultId: string; zones: ZoneFootprint[] } | null,
  holes: number[][][] = [],
): SpatialOverlap {
  const empty: SpatialOverlap = { sourceResultId: source?.resultId ?? null, status: "unavailable", geometryAreaHa: null, overlapAreaHa: null, overlapFraction: null, contributingZoneIds: [] };
  if (!source) return empty;
  const target = validPolygon(ring, holes);
  const candidates = source.zones.map((zone) => ({ id: zone.id, geometry: validPolygon(zone.zone, zone.holes) }));
  if (!target || candidates.some((zone) => !zone.geometry)) return { ...empty, status: "invalid_geometry" };
  try {
    const targetArea = area(target);
    const intersections = candidates.flatMap((zone) => {
      const overlap = intersect(featureCollection([target, zone.geometry!]));
      return overlap && area(overlap) > 0 ? [{ id: zone.id, geometry: overlap }] : [];
    });
    const geometries = intersections.map((zone) => zone.geometry);
    const combined = geometries.length > 1 ? union(featureCollection(geometries)) : geometries[0];
    if (geometries.length && !combined) return { ...empty, status: "calculation_failed" };
    const overlapArea = combined ? area(combined) : 0;
    return { ...empty, status: "computed", geometryAreaHa: targetArea / 10_000, overlapAreaHa: overlapArea / 10_000, overlapFraction: Math.min(1, overlapArea / targetArea), contributingZoneIds: intersections.map((zone) => zone.id) };
  } catch {
    return { ...empty, status: "calculation_failed" };
  }
}

/** Compares same-location relative classes only within observed footprints. */
export function compareRelativeZoneCoverage(
  previous: Array<ZoneFootprint & { class: string }>,
  current: Array<ZoneFootprint & { class: string }>,
): RelativeZoneCoverageChange {
  const empty = { areas: null, currentBelowZones: [] };
  // Old saved exterior-only rings cannot establish which holes were observed.
  if ([...previous, ...current].some((zone) => !Array.isArray(zone.holes))) return { ...empty, status: "incomplete_geometry" };
  const parse = (zones: typeof previous) => zones.map((zone) => ({ ...zone, geometry: validPolygon(zone.zone, zone.holes) }));
  const before = parse(previous);
  const after = parse(current);
  if ([...before, ...after].some((zone) => !zone.geometry)) return { ...empty, status: "invalid_geometry" };
  try {
    type Footprint = NonNullable<(typeof before)[number]["geometry"]>;
    type Combined = ReturnType<typeof union>;
    const combine = (zones: typeof before): Combined => {
      const geometries = zones.map((zone) => zone.geometry as Footprint);
      if (!geometries.length) return null;
      if (geometries.length === 1) return geometries[0]!;
      const combined = union(featureCollection(geometries));
      if (!combined) throw new Error("Nonempty footprints could not be combined");
      return combined;
    };
    const overlap = (left: Combined, right: Combined): Combined => left && right ? intersect(featureCollection([left, right])) : null;
    const hectares = (geometry: Combined) => geometry ? area(geometry) / 10_000 : 0;
    const beforeAll = combine(before);
    const afterAll = combine(after);
    const beforeBelow = before.filter((zone) => zone.class === "below_average");
    const afterBelow = after.filter((zone) => zone.class === "below_average");
    const beforeWeak = combine(beforeBelow);
    const afterWeak = combine(afterBelow);
    const bothWeakHa = hectares(overlap(beforeWeak, afterWeak));
    const beforeWeakCommonHa = hectares(overlap(beforeWeak, afterAll));
    const afterWeakCommonHa = hectares(overlap(afterWeak, beforeAll));
    const nonnegativeDifference = (total: number, subset: number) => Math.max(0, total - subset);
    return {
      status: "computed",
      areas: {
        previousObservedHa: hectares(beforeAll), currentObservedHa: hectares(afterAll),
        commonObservedHa: hectares(overlap(beforeAll, afterAll)), belowOnBothDatesHa: bothWeakHa,
        newlyBelowWithinCommonHa: nonnegativeDifference(afterWeakCommonHa, bothWeakHa),
        noLongerBelowWithinCommonHa: nonnegativeDifference(beforeWeakCommonHa, bothWeakHa),
        currentBelowUnobservedPreviouslyHa: nonnegativeDifference(hectares(afterWeak), afterWeakCommonHa),
        previousBelowUnobservedCurrentlyHa: nonnegativeDifference(hectares(beforeWeak), beforeWeakCommonHa),
      },
      currentBelowZones: afterBelow.map((zone) => {
        const previouslyObservedHa = hectares(overlap(zone.geometry, beforeAll));
        const belowOnBothDatesHa = hectares(overlap(zone.geometry, beforeWeak));
        return {
          id: zone.id, previouslyObservedHa, belowOnBothDatesHa,
          newlyBelowWithinCommonHa: nonnegativeDifference(previouslyObservedHa, belowOnBothDatesHa),
          unobservedPreviouslyHa: nonnegativeDifference(hectares(zone.geometry), previouslyObservedHa),
          previousBelowZoneIds: beforeBelow.filter((prior) => hectares(overlap(zone.geometry, prior.geometry)) > 0).map((prior) => prior.id),
        };
      }),
    };
  } catch {
    return { ...empty, status: "calculation_failed" };
  }
}

export function observationInsideZone(point: [number, number], ring: number[][], holes: number[][][] = []): boolean | null {
  const geometry = validPolygon(ring, holes);
  if (!geometry || !validCoordinate(point)) return null;
  return booleanPointInPolygon(point, geometry);
}

function validCoordinate(point: number[]): boolean {
  return point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && Math.abs(point[0]!) <= 180 && Math.abs(point[1]!) <= 90;
}

function validPolygon(ring: number[][], holes: number[][][] = []): ReturnType<typeof polygon> | null {
  if (![ring, ...holes].every((coordinates) => coordinates.length >= 4 && coordinates.every(validCoordinate)
    && coordinates[0]![0] === coordinates.at(-1)![0] && coordinates[0]![1] === coordinates.at(-1)![1])) return null;
  try {
    const geometry = polygon([ring, ...holes]);
    if (area(geometry) <= 0 || kinks(geometry).features.length) return null;
    const outer = polygon([ring]);
    const interiors = holes.map((hole) => polygon([hole]));
    for (const [index, hole] of interiors.entries()) {
      const contained = intersect(featureCollection([outer, hole]));
      if (!contained || Math.abs(area(hole) - area(contained)) > Math.max(0.0001, area(hole) * 1e-9)) return null;
      if (interiors.slice(0, index).some((prior) => {
        const overlap = intersect(featureCollection([hole, prior]));
        return overlap && area(overlap) > 0;
      })) return null;
    }
    return geometry;
  } catch {
    return null;
  }
}
