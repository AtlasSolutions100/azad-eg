import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { detectSchemaDrift, describeDrift, DB_PUSH_COMMAND } from "./schemaDrift";
import { apiErrorHandler } from "../app";

describe("schema drift check", () => {
  it("finds nothing missing when the database matches the code", async () => {
    // The test database has had `db push` run against this checkout.
    expect(await detectSchemaDrift()).toEqual([]);
  });

  it("names the column and the command that fixes it", () => {
    const text = describeDrift([{ table: "packages", missing: ["previous_hours"] }]);
    expect(text).toContain("packages.previous_hours");
    expect(text).toContain(DB_PUSH_COMMAND);
    expect(text).toContain("restart");
  });
});

describe("API error handler", () => {
  function appThrowing(err: unknown) {
    const app = express();
    app.get("/boom", () => {
      throw err;
    });
    app.use(apiErrorHandler);
    return app;
  }

  it("turns a missing-column error into JSON that says to run db push", async () => {
    // What Julie saw: the first package created after `previous_hours` shipped,
    // on a deployment where the schema step had been skipped.
    const pg = Object.assign(new Error('column "previous_hours" of relation "packages" does not exist'), {
      code: "42703",
    });
    const wrapped = new Error("Failed query: insert into packages …", { cause: pg });
    const res = await request(appThrowing(wrapped)).get("/boom");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.code).toBe("schema_out_of_date");
    expect(res.body.error).toContain(DB_PUSH_COMMAND);
  });

  it("never answers an API error with HTML", async () => {
    const res = await request(appThrowing(new Error("something else"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
