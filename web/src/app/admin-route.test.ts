import { expect, it } from "vitest";
import { matchRoute } from "./routes";

it("opens public board settings at /admin and /admin/", () => {
  expect(matchRoute("/admin").pageId).toBe("admin");
  expect(matchRoute("/admin/").pageId).toBe("admin");
});
