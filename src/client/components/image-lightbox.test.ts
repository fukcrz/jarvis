import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagramLightboxContent, ImagePreview, clampScale, nextAngle, nextScale } from "./image-lightbox";

describe("image lightbox transform helpers", () => {
  it("zooms by a fixed step and clamps to the 0.1x–5x range", () => {
    expect(nextScale(1, 1)).toBeCloseTo(1.2);
    expect(nextScale(1, -1)).toBeCloseTo(1 / 1.2);
    expect(nextScale(4.9, 1)).toBe(5);
    expect(nextScale(0.11, -1)).toBe(0.1);
    expect(clampScale(12)).toBe(5);
    expect(clampScale(0.01)).toBe(0.1);
  });

  it("rotates in 90° steps and keeps the angle normalized", () => {
    expect(nextAngle(0, 1)).toBe(90);
    expect(nextAngle(270, 1)).toBe(0);
    expect(nextAngle(0, -1)).toBe(270);
    expect(nextAngle(90, -1)).toBe(0);
  });
});

describe("ImagePreview", () => {
  it("renders the trigger without mounting the overlay", () => {
    const markup = renderToStaticMarkup(createElement(ImagePreview, {
      src: "/api/files?path=shot.png",
      alt: "截图",
      className: "message-image-frame",
      children: createElement("img", { src: "/api/files?path=shot.png", alt: "截图" }),
    }));

    expect(markup).toContain('class="message-image-frame"');
    expect(markup).toContain('src="/api/files?path=shot.png"');
    expect(markup).not.toContain("image-lightbox");
  });
});

describe("DiagramLightboxContent", () => {
  it("wraps the rendered svg for the zoom overlay", () => {
    const markup = renderToStaticMarkup(createElement(DiagramLightboxContent, {
      svg: "<svg id=\"chart\"><g /></svg>",
    }));
    expect(markup).toContain("image-lightbox-diagram");
    expect(markup).toContain('id="chart"');
  });
});


