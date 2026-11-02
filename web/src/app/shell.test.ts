/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAppServices } from "./services";
import { mountShell } from "./shell";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app shell", () => {
  it("does not list the owner console (/admin) in the public nav or the wallet panel", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const navHrefs = [...host.querySelectorAll<HTMLAnchorElement>(".app-nav a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(navHrefs).toEqual(["/wall", "/money"]);
    expect(host.querySelector('a[href="/admin"]')).toBeNull();
    shell.dispose();
  });

  it("shows one wallet control: Connect while disconnected, the panel hidden", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const connect = host.querySelector<HTMLButtonElement>("#connect-button")!;
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;
    expect(connect.textContent).toBe("Connect wallet");
    expect(details.hidden).toBe(true);
    expect(details.contains(connect)).toBe(false);
    // The status line is duplicated in the paint dock; the shell copy is screen-reader only.
    expect(host.querySelector(".shell-status")?.classList.contains("visually-hidden")).toBe(true);
    shell.dispose();
  });
});
