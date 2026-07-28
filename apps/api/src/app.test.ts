import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("analysis API", () => {
  it("reports that Planet is not configured without exposing credentials", async () => {
    const app = buildApp({
      planetClient: {
        checkAccess: async () => ({
          configured: false,
          reachable: false,
          planetScopeAvailable: false,
          itemTypes: [],
          message: "尚未配置 Planet API 密钥。",
        }),
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/integrations/planet" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, itemTypes: [] });
  });

  it("starts with no preloaded demonstration fields", async () => {
    const app = buildApp();
    apps.push(app);

    const fieldsResponse = await app.inject({ method: "GET", url: "/api/v1/fields" });
    expect(fieldsResponse.statusCode).toBe(200);
    expect(fieldsResponse.json().fields).toEqual([]);

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        fieldId: "field-not-yet-imported",
        crop: "corn",
        period: "last_30_days",
        objective: "recent_change",
      },
    });
    expect(taskResponse.statusCode).toBe(404);
    expect(taskResponse.json().code).toBe("field_not_found");
  });

  it("creates, updates, and archives a validated field", async () => {
    const app = buildApp();
    apps.push(app);
    const boundary = [
      { longitude: 123.8, latitude: 42.3 },
      { longitude: 123.81, latitude: 42.3 },
      { longitude: 123.81, latitude: 42.31 },
      { longitude: 123.8, latitude: 42.31 },
    ];

    const created = await app.inject({ method: "POST", url: "/api/v1/fields", payload: { name: "北田 01", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: "先玉 335", boundary } });
    expect(created.statusCode).toBe(201);
    expect(created.json().field).toMatchObject({ name: "北田 01", plantingDate: "2026-05-04", variety: "先玉 335" });
    expect(created.json().field.boundary).toHaveLength(5);
    const id = created.json().field.id as string;

    const updated = await app.inject({ method: "PATCH", url: `/api/v1/fields/${id}`, payload: { name: "北田 02" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().field).toMatchObject({ name: "北田 02", plantingDate: "2026-05-04", variety: "先玉 335" });

    const archived = await app.inject({ method: "DELETE", url: `/api/v1/fields/${id}` });
    expect(archived.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/fields" })).json().fields).toEqual([]);
  });

  it("rejects self-intersecting field geometry", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "无效边界", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("invalid_field");
  });

  it("does not invent a result for an unknown unsupported-crop field", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        fieldId: "field-not-yet-imported",
        crop: "soybean",
        period: "last_30_days",
        objective: "recent_change",
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("field_not_found");
  });
});
