/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWallModes } from "./wall-modes";
import { createWallScope } from "./wall-scope";

function setup() {
  document.body.innerHTML = `
    <div class="wall-page">
      <button id="move"></button>
      <button id="start"></button><button id="back"></button>
    </div>`;
  const $ = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
  const changes: Array<[string, boolean]> = [];
  const modes = createWallModes({
    scope: createWallScope(),
    page: document.querySelector<HTMLElement>(".wall-page")!,
    moveButton: $("move"),
    startPainting: $("start"),
    backToLook: $("back"),
    onChange: (mode, moving) => changes.push([mode, moving]),
  });
  return { modes, $, page: document.querySelector<HTMLElement>(".wall-page")!, changes };
}

describe("createWallModes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens in Look: every drag pans and a tap never paints", () => {
    const { modes, $, page } = setup();
    expect(modes.mode()).toBe("look");
    expect(modes.panOnly()).toBe(true);
    expect(modes.tapMayPaint()).toBe(false);
    expect(page.dataset.mode).toBe("look");
    expect($("move").hidden).toBe(true);
  });

  it("Paint lets drags and taps paint, and shows Move", () => {
    const { modes, $, page } = setup();
    modes.setMode("paint");
    expect(modes.mode()).toBe("paint");
    expect(modes.panOnly()).toBe(false);
    expect(modes.tapMayPaint()).toBe(true);
    expect(page.dataset.mode).toBe("paint");
    expect($("move").hidden).toBe(false);
  });

  it("Move makes a Paint drag pan and stops taps painting", () => {
    const { modes, $, page } = setup();
    modes.setMode("paint");
    $("move").click();
    expect(modes.moving()).toBe(true);
    expect(modes.panOnly()).toBe(true);
    expect(modes.tapMayPaint()).toBe(false);
    expect(page.dataset.moving).toBe("true");
    expect($("move").getAttribute("aria-pressed")).toBe("true");
    $("move").click();
    expect(modes.panOnly()).toBe(false);
  });

  it("leaving Paint turns Move off, and Move can't be switched on in Look", () => {
    const { modes, $ } = setup();
    modes.setMode("paint");
    $("move").click();
    modes.setMode("look");
    expect(modes.moving()).toBe(false);
    modes.setMoving(true);
    expect(modes.moving()).toBe(false);
  });

  it("Start painting and Just looking switch modes", () => {
    const { modes, $, changes } = setup();
    $("start").click();
    expect(modes.mode()).toBe("paint");
    $("back").click();
    expect(modes.mode()).toBe("look");
    expect(changes.map(([mode]) => mode)).toEqual(["look", "paint", "look"]);
  });
});
