import { describe, expect, it } from "vitest";

import { isImagePath, payloadCanMountImage } from "./upload";

describe("isImagePath — all four PS5 disk-image formats", () => {
  it("recognizes exFAT, UFS, PFS, and compressed/nested PFS", () => {
    expect(isImagePath("/x/game.exfat")).toBe(true);
    expect(isImagePath("/x/game.ffpkg")).toBe(true);
    expect(isImagePath("/x/game.ffpfs")).toBe(true);
    expect(isImagePath("/x/game.ffpfsc")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isImagePath("/X/GAME.FFPKG")).toBe(true);
    expect(isImagePath("/X/GAME.Ffpfsc")).toBe(true);
  });
  it("rejects non-images", () => {
    expect(isImagePath("/x/game.pkg")).toBe(false);
    expect(isImagePath("/x/game.zip")).toBe(false);
    expect(isImagePath("/x/folder")).toBe(false);
    expect(isImagePath("/x/game.ffp")).toBe(false);
  });
});

describe("payloadCanMountImage — ps5upload's own mount vs SMP-only", () => {
  it("ps5upload can attach exFAT / UFS / PFS directly", () => {
    expect(payloadCanMountImage("/x/g.exfat")).toBe(true);
    expect(payloadCanMountImage("/x/g.ffpkg")).toBe(true);
    expect(payloadCanMountImage("/x/g.ffpfs")).toBe(true);
  });
  it("a .ffpfsc container is NOT directly mountable (ShadowMount+ only)", () => {
    expect(isImagePath("/x/g.ffpfsc")).toBe(true);
    expect(payloadCanMountImage("/x/g.ffpfsc")).toBe(false);
  });
});
