import type { AnalysisFinding, FieldSummary } from "@chernozem/contracts";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

interface MapCanvasProps {
  fields: FieldSummary[];
  selectedFieldId: string | null;
  findings: AnalysisFinding[];
  locateSignal: number;
  onSelectField: (fieldId: string) => void;
  onLocationError: (message: string) => void;
  drawing: boolean;
  draftBoundary: FieldSummary["boundary"] | null;
  onBoundaryDrawn: (boundary: FieldSummary["boundary"] | null) => void;
}

const FIELD_SOURCE = "fields";
const FINDING_SOURCE = "findings";
const SATELLITE_SOURCE = "satellite-basemap";
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
  locateSignal,
  onSelectField,
  onLocationError,
  drawing,
  draftBoundary,
  onBoundaryDrawn,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [123.835, 42.298],
      zoom: 13.2,
      attributionControl: { compact: true },
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
      map.addSource(FINDING_SOURCE, { type: "geojson", data: findingsGeoJson(findings) });
      map.addLayer({
        id: "finding-fill",
        type: "fill",
        source: FINDING_SOURCE,
        paint: { "fill-color": "#c85e42", "fill-opacity": 0.56 },
      });
      map.addLayer({
        id: "finding-outline",
        type: "line",
        source: FINDING_SOURCE,
        paint: { "line-color": "#953d2b", "line-width": 2 },
      });

      map.on("click", "field-fill", (event) => {
        const id = event.features?.[0]?.properties.id as string | undefined;
        if (id) onSelectField(id);
      });
      map.on("mouseenter", "field-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "field-fill", () => {
        map.getCanvas().style.cursor = "";
      });
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
    if (!mapReady || !map?.isStyleLoaded()) return;
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
      0.34,
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
      map.flyTo({ center: [selected.centroid.longitude, selected.centroid.latitude], zoom: 14.1, duration: 650 });
    }
  }, [fields, mapReady, selectedFieldId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map?.isStyleLoaded()) return;
    (map.getSource(FINDING_SOURCE) as GeoJSONSource | undefined)?.setData(findingsGeoJson(findings));
  }, [findings, mapReady]);

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

  return <div ref={containerRef} className={`h-full w-full map-canvas${drawing ? " is-drawing" : ""}`} aria-label="农田地图" />;
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
        properties: { id: finding.id, title: finding.title },
        geometry: {
          type: "Polygon" as const,
          coordinates: [finding.zone!.map((point) => [point.longitude, point.latitude])],
        },
      })),
  };
}
