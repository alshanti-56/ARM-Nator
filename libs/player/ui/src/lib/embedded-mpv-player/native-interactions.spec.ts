import { EmbeddedMpvLegacyInteractions } from "./embedded-mpv-legacy-interactions";
import type { EmbeddedMpvLegacyInteractionsDeps } from "./embedded-mpv-legacy-interactions";
it("double clicks on editable/menu elements never toggle picture fullscreen", () => {
  const fullscreen = jest.fn();
  const i = new EmbeddedMpvLegacyInteractions({
    isAvailable: () => true,
    toggleFullscreen: fullscreen,
  } as unknown as EmbeddedMpvLegacyInteractionsDeps);
  for (const html of [
    "<textarea></textarea>",
    '<div contenteditable="true"></div>',
    '<div role="menu"><span>item</span></div>',
    '<a href="#">link</a>',
  ]) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    i.onPlayerDblClick({
      target: wrap.querySelector("span") ?? wrap.firstElementChild,
      defaultPrevented: false,
    } as unknown as MouseEvent);
  }
  expect(fullscreen).not.toHaveBeenCalled();
  const target = document.createElement("div");
  i.onPlayerDblClick({
    target,
    defaultPrevented: false,
  } as unknown as MouseEvent);
  expect(fullscreen).toHaveBeenCalledTimes(1);
});
