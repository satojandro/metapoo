import { expect, it } from "vitest";
import { matchRoute } from "./routes";

it("opens the owner console at /admin and /admin/", () => {
  expect(matchRoute("/admin").pageId).toBe("admin");
  expect(matchRoute("/admin/").pageId).toBe("admin");
});
