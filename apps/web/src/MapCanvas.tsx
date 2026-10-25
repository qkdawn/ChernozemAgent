import type { AnalysisArtifact, AnalysisFinding, FieldScoutingNote, FieldSummary, Position, VariableNitrogenZone } from "@chernozem/contracts";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

interface MapCanvasProps {
  fields: FieldSummary[];
  selectedFieldId: string | null;
  findings: AnalysisFinding[];
  focusedFindingId: string | null;
  scoutingNotes: FieldScoutingNote[];
  focusedScoutingNoteId: string | null;
  visualizationLayer: MapVisualizationLayer | null;
  nitrogenZones: VariableNitrogenZone[];
  spatialOverlays?: {
    fieldBoundary: boolean;
    taskFindings: boolean;
    scoutingNotes: boolean;
    nitrogenZones: boolean;
  };
  focusFieldSignal: number;
  locateSignal: number;
  fieldPanelOpen: boolean;
  detailPanelOpen: boolean;
  onSelectField: (fieldId: string) => void;
  onSelectScoutingNote: (noteId: string) => void;
  onLocationError: (message: string) => void;
  drawing: boolean;
  draftBoundary: FieldSummary["boundary"] | null;
  onBoundaryDrawn: (boundary: FieldSummary["boundary"] | null) => void;
  inspectionPicking: boolean;
  inspectionLocation: Position | null;
  onInspectionLocationChange: (location: Position) => void;
}

export type MapVisualizationLayer = NonNullable<AnalysisArtifact["visualization"]> & { ref: string; taskId?: string };

const FIELD_SOURCE = "fields";
const FINDING_SOURCE = "findings";
const SATELLITE_SOURCE = "satellite-basemap";
const VISUALIZATION_SOURCE = "analysis-visualization";
const VISUALIZATION_LAYER = "analysis-visualization-layer";
const INSPECTION_SOURCE = "inspection-location";
const SCOUTING_SOURCE = "field-scouting-notes";
const NITROGEN_SOURCE = "nitrogen-prescription";
const drawTheme = (MapboxDraw as unknown as { lib: { theme: Array<Record<string, unknown>> } }).lib.theme;
const mapLibreDrawStyles = drawTheme.map((style) => {
  if (style.id !== "gl-draw-lines") return style;
  return {
    ...style,
    paint: {
      ...(style.paint as Record<string, unknown>),
      "line-dasharray": ["case", ["==", ["get", "active"], "true"], ["literal", [0.2, 2]], ["literal", [2, 0]]],
    },
  };
});

export function MapCanvas({
  fields,
  selectedFieldId,
  findings,
  focusedFindingId,
  scoutingNotes,
  focusedScoutingNoteId,
  visualizationLayer,
  nitrogenZones = [],
  spatialOverlays = { fieldBoundary: true, taskFindings: true, scoutingNotes: true, nitrogenZones: true },
  focusFieldSignal,
  locateSignal,
  fieldPanelOpen,
  detailPanelOpen,
  onSelectField,
  onSelectScoutingNote,
  onLocationError,
  drawing,
  draftBoundary,
  onBoundaryDrawn,
  inspectionPicking,
  inspectionLocation,
  onInspectionLocationChange,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const inspectionPickingRef = useRef(inspectionPicking);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    inspectionPickingRef.current = inspectionPicking;
  }, [inspectionPicking]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [123.835, 42.298],
      zoom: 13.2,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          [SATELLITE_SOURCE]: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Tiles © Esri",
          },
        },
        layers: [{ id: SATELLITE_SOURCE, type: "raster", source: SATELLITE_SOURCE }],
      },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      defaultMode: "simple_select",
      styles: mapLibreDrawStyles,
    });
    drawRef.current = draw;
    map.addControl(draw as unknown as maplibregl.IControl, "top-right");
    const notifyBoundary = () => {
      const feature = draw.getAll().features[0];
      if (!feature || feature.geometry.type !== "Polygon") return onBoundaryDrawn(null);
      const ring = feature.geometry.coordinates[0];
      if (!ring) return onBoundaryDrawn(null);
      onBoundaryDrawn(ring.map((coordinate) => ({ longitude: coordinate[0]!, latitude: coordinate[1]! })));
    };
    map.on("draw.create", notifyBoundary);
    map.on("draw.update", notifyBoundary);
    map.on("draw.delete", notifyBoundary);

    map.on("style.load", () => {
      map.addSource(FIELD_SOURCE, { type: "geojson", data: fieldsGeoJson(fields) });
      map.addLayer({
        id: "field-fill",
        type: "fill",
        source: FIELD_SOURCE,
        paint: {
          "fill-color": ["case", ["==", ["get", "id"], selectedFieldId ?? ""], "#42bd70", "#91a594"],
          "fill-opacity": ["case", ["==", ["get", "id"], selectedFieldId ?? ""], 0.34, 0.08],
        },
      });
      map.addLayer({
        id: "field-outline",
        type: "line",
        source: FIELD_SOURCE,
        paint: {
          "line-color": ["case", ["==", ["get", "id"], selectedFieldId ?? ""], "#f6fff8", "#b8c7bc"],
          "line-width": ["case", ["==", ["get", "id"], selectedFieldId ?? ""], 2.5, 1.2],
        },
      });
      map.addSource(NITROGEN_SOURCE, { type: "geojson", data: nitrogenZonesGeoJson(nitrogenZones) });
      map.addLayer({
        id: "nitrogen-prescription-fill",
        type: "fill",
        source: NITROGEN_SOURCE,
        paint: {
          "fill-color": ["match", ["get", "level"], "low", "#b87635", "medium", "#b9a83e", "high", "#3f8a57", "#87918a"],
          "fill-opacity": 0.68,
        },
      }, "field-outline");
      map.addLayer({
        id: "nitrogen-prescription-outline",
        type: "line",
        source: NITROGEN_SOURCE,
        paint: { "line-color": "#ffffff", "line-width": 1.2, "line-opacity": 0.9 },
      }, "field-outline");
      map.addSource(FINDING_SOURCE, { type: "geojson", data: findingsGeoJson(findings) });
      map.addLayer({
        id: "finding-fill",
        type: "fill",
        source: FINDING_SOURCE,
        paint: { "fill-color": ["match", ["get", "findingType"], "candidate_zone", "#c85e42", "observation_zone", "#d09b45", "#c85e42"], "fill-opacity": 0.56 },
      });
      map.addSource(INSPECTION_SOURCE, { type: "geojson", data: inspectionGeoJson(null) });
      map.addLayer({ id: "inspection-location-halo", type: "circle", source: INSPECTION_SOURCE, paint: { "circle-radius": 10, "circle-color": "#ffffff", "circle-opacity": 0.9 } });
      map.addLayer({ id: "inspection-location-point", type: "circle", source: INSPECTION_SOURCE, paint: { "circle-radius": 6, "circle-color": "#207b45", "circle-stroke-color": "#173d27", "circle-stroke-width": 1.5 } });
      map.addSource(SCOUTING_SOURCE, { type: "geojson", data: scoutingNotesGeoJson(scoutingNotes) });
      map.addLayer({ id: "scouting-note-halo", type: "circle", source: SCOUTING_SOURCE, paint: { "circle-radius": ["case", ["==", ["get", "id"], focusedScoutingNoteId ?? ""], 12, 9], "circle-color": "#ffffff", "circle-opacity": 0.94 } });
      map.addLayer({ id: "scouting-note-point", type: "circle", source: SCOUTING_SOURCE, paint: { "circle-radius": ["case", ["==", ["get", "id"], focusedScoutingNoteId ?? ""], 7, 5], "circle-color": "#247849", "circle-stroke-color": "#173d27", "circle-stroke-width": 1.4 } });
      map.addLayer({
        id: "finding-outline",
        type: "line",
        source: FINDING_SOURCE,
        paint: { "line-color": ["match", ["get", "findingType"], "candidate_zone", "#953d2b", "observation_zone", "#a56f23", "#953d2b"], "line-width": 2 },
      });

      map.on("click", "field-fill", (event) => {
        if (inspectionPickingRef.current) return;
        const id = event.features?.[0]?.properties.id as string | undefined;
        if (id) onSelectField(id);
      });
      map.on("mouseenter", "field-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "field-fill", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "scouting-note-point", (event) => {
        const id = event.features?.[0]?.properties.id as string | undefined;
        if (id) onSelectScoutingNote(id);
      });
      map.on("mouseenter", "scouting-note-point", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "scouting-note-point", () => { map.getCanvas().style.cursor = ""; });
      setMapReady(true);
    });

    mapRef.current = map;
    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw) return;
    if (drawing) {
      if (draftBoundary && draw.getAll().features.length === 0) {
        draw.add({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [draftBoundary.map((point) => [point.longitude, point.latitude])] } });
        draw.changeMode("simple_select");
      } else if (!draftBoundary) {
        draw.changeMode("draw_polygon");
      }
      return;
    }
    draw.deleteAll();
    draw.changeMode("simple_select");
  }, [drawing, draftBoundary, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    (map.getSource(FIELD_SOURCE) as GeoJSONSource | undefined)?.setData(fieldsGeoJson(fields));
    map.setPaintProperty("field-fill", "fill-color", [
      "case",
      ["==", ["get", "id"], selectedFieldId ?? ""],
      "#42bd70",
      "#91a594",
    ]);
    map.setPaintProperty("field-fill", "fill-opacity", [
      "case",
      ["==", ["get", "id"], selectedFieldId ?? ""],
      visualizationLayer || nitrogenZones.length ? 0 : 0.34,
      0.08,
    ]);
    map.setPaintProperty("field-outline", "line-color", [
      "case",
      ["==", ["get", "id"], selectedFieldId ?? ""],
      "#f6fff8",
      "#b8c7bc",
    ]);
    map.setPaintProperty("field-outline", "line-width", [
      "case",
      ["==", ["get", "id"], selectedFieldId ?? ""],
      2.5,
      1.2,
    ]);

    const selected = fields.find((field) => field.id === selectedFieldId);
    if (selected) {
      const longitudes = selected.boundary.map((point) => point.longitude);
      const latitudes = selected.boundary.map((point) => point.latitude);
      map.fitBounds(
        [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
        {
          padding: window.innerWidth <= 760
            ? { top: 56, right: 40, bottom: Math.round(window.innerHeight * 0.58), left: 40 }
            : { top: 72, right: detailPanelOpen ? 500 : 72, bottom: 72, left: fieldPanelOpen ? 500 : 72 },
          maxZoom: 16.5,
          duration: 650,
        },
      );
    }
  }, [detailPanelOpen, fieldPanelOpen, fields, focusFieldSignal, mapReady, nitrogenZones.length, selectedFieldId, visualizationLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    (map.getSource(NITROGEN_SOURCE) as GeoJSONSource | undefined)?.setData(nitrogenZonesGeoJson(nitrogenZones));
  }, [mapReady, nitrogenZones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const visibility = (visible: boolean) => visible ? "visible" : "none";
    for (const layerId of ["field-fill", "field-outline"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility(spatialOverlays.fieldBoundary));
    }
    for (const layerId of ["finding-fill", "finding-outline"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility(spatialOverlays.taskFindings));
    }
    for (const layerId of ["scouting-note-halo", "scouting-note-point"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility(spatialOverlays.scoutingNotes));
    }
    for (const layerId of ["nitrogen-prescription-fill", "nitrogen-prescription-outline"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility(spatialOverlays.nitrogenZones));
    }
  }, [mapReady, spatialOverlays]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    (map.getSource(FINDING_SOURCE) as GeoJSONSource | undefined)?.setData(findingsGeoJson(findings));
    map.setPaintProperty("finding-fill", "fill-opacity", ["case", ["==", ["get", "id"], focusedFindingId ?? ""], 0.74, 0.46]);
    map.setPaintProperty("finding-outline", "line-width", ["case", ["==", ["get", "id"], focusedFindingId ?? ""], 3, 1.6]);
    const focused = findings.find((finding) => finding.id === focusedFindingId && finding.zone);
    if (!focused?.zone?.length) return;
    const longitudes = focused.zone.map((point) => point.longitude);
    const latitudes = focused.zone.map((point) => point.latitude);
    const padding = window.innerWidth <= 760
      ? { top: 48, right: 48, bottom: Math.round(window.innerHeight * 0.62) + 32, left: 48 }
      : { top: 84, right: detailPanelOpen ? 500 : 84, bottom: 84, left: fieldPanelOpen ? 500 : 84 };
    map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding, maxZoom: 15.5, duration: 650 });
  }, [detailPanelOpen, fieldPanelOpen, findings, focusedFindingId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    (map.getSource(SCOUTING_SOURCE) as GeoJSONSource | undefined)?.setData(scoutingNotesGeoJson(scoutingNotes));
    map.setPaintProperty("scouting-note-halo", "circle-radius", ["case", ["==", ["get", "id"], focusedScoutingNoteId ?? ""], 12, 9]);
    map.setPaintProperty("scouting-note-point", "circle-radius", ["case", ["==", ["get", "id"], focusedScoutingNoteId ?? ""], 7, 5]);
    const focused = scoutingNotes.find((note) => note.id === focusedScoutingNoteId);
    if (focused) map.flyTo({ center: [focused.location.longitude, focused.location.latitude], zoom: Math.max(map.getZoom(), 16), duration: 550 });
  }, [focusedScoutingNoteId, mapReady, scoutingNotes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (map.getLayer(VISUALIZATION_LAYER)) map.removeLayer(VISUALIZATION_LAYER);
    if (map.getSource(VISUALIZATION_SOURCE)) map.removeSource(VISUALIZATION_SOURCE);
    if (!visualizationLayer) return;
    map.addSource(VISUALIZATION_SOURCE, {
      type: "image",
      url: artifactUrl(visualizationLayer.ref),
      coordinates: visualizationLayer.bounds,
    });
    map.addLayer({
      id: VISUALIZATION_LAYER,
      type: "raster",
      source: VISUALIZATION_SOURCE,
      paint: {
        "raster-opacity": 1,
        "raster-fade-duration": 180,
        "raster-resampling": "nearest",
      },
    }, "field-outline");
  }, [mapReady, visualizationLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    (map.getSource(INSPECTION_SOURCE) as GeoJSONSource | undefined)?.setData(inspectionGeoJson(inspectionLocation));
  }, [inspectionLocation, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !inspectionPicking) return;
    map.getCanvas().style.cursor = "crosshair";
    const selectedField = fields.find((field) => field.id === selectedFieldId);
    const pick = (event: maplibregl.MapMouseEvent) => {
      if (!selectedField) return onLocationError("请先选择要记录的地块。");
      const location = { longitude: event.lngLat.lng, latitude: event.lngLat.lat };
      if (!pointInPolygon(location, selectedField.boundary)) return onLocationError("现场记录点必须位于当前地块边界内。");
      onInspectionLocationChange(location);
    };
    map.on("click", pick);
    return () => {
      map.off("click", pick);
      map.getCanvas().style.cursor = "";
    };
  }, [fields, onInspectionLocationChange, onLocationError, inspectionPicking, mapReady, selectedFieldId]);

  useEffect(() => {
    if (locateSignal === 0) return;
    if (!navigator.geolocation) {
      onLocationError("当前浏览器无法获取位置。");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        mapRef.current?.flyTo({ center: [coords.longitude, coords.latitude], zoom: 14, duration: 800 });
      },
      () => onLocationError("未能获取当前位置，请检查浏览器定位权限。"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [locateSignal, onLocationError]);

  return <div ref={containerRef} className={`h-full w-full map-canvas${drawing ? " is-drawing" : ""}${inspectionPicking ? " is-picking-inspection" : ""}`} aria-label="农田地图" />;
}

function artifactUrl(ref: string): string {
  return `/api/v1/artifacts/${ref.split("/").map(encodeURIComponent).join("/")}`;
}

function fieldsGeoJson(fields: FieldSummary[]) {
  return {
    type: "FeatureCollection" as const,
    features: fields.map((field) => ({
      type: "Feature" as const,
      properties: { id: field.id, name: field.name },
      geometry: {
        type: "Polygon" as const,
        coordinates: [field.boundary.map((point) => [point.longitude, point.latitude])],
      },
    })),
  };
}

function findingsGeoJson(findings: AnalysisFinding[]) {
  return {
    type: "FeatureCollection" as const,
    features: findings
      .filter((finding) => finding.zone)
      .map((finding) => ({
        type: "Feature" as const,
        properties: { id: finding.id, title: finding.title, findingType: finding.findingType ?? "other" },
        geometry: {
          type: "Polygon" as const,
          coordinates: [finding.zone!, ...(finding.zoneHoles ?? [])].map((ring) => ring.map((point) => [point.longitude, point.latitude])),
        },
      })),
  };
}

function nitrogenZonesGeoJson(zones: VariableNitrogenZone[]) {
  return {
    type: "FeatureCollection" as const,
    features: zones.flatMap((zone) => zone.polygons.map((ring, index) => ({
      type: "Feature" as const,
      properties: { id: `${zone.id}-${index}`, level: zone.level, label: zone.label, rate: zone.productRateKgHa },
      geometry: {
        type: "Polygon" as const,
        coordinates: [ring.map((point) => [point.longitude, point.latitude])],
      },
    }))),
  };
}

function inspectionGeoJson(location: Position | null) {
  return {
    type: "FeatureCollection" as const,
    features: location ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: [location.longitude, location.latitude] } }] : [],
  };
}

function scoutingNotesGeoJson(notes: FieldScoutingNote[]) {
  return {
    type: "FeatureCollection" as const,
    features: notes.map((note) => ({
      type: "Feature" as const,
      properties: { id: note.id, observedAt: note.observedAt },
      geometry: { type: "Point" as const, coordinates: [note.location.longitude, note.location.latitude] },
    })),
  };
}

function pointInPolygon(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index]!;
    const previousPoint = ring[previous]!;
    const intersects = ((currentPoint.latitude > point.latitude) !== (previousPoint.latitude > point.latitude))
      && point.longitude < (previousPoint.longitude - currentPoint.longitude) * (point.latitude - currentPoint.latitude) / (previousPoint.latitude - currentPoint.latitude) + currentPoint.longitude;
    if (intersects) inside = !inside;
  }
  return inside;
}
