import { describe, expect, it } from "vitest";

import { isRemovableMount, removableMountRoot } from "./mountPaths";

describe("isRemovableMount", () => {
  it("is true for /mnt/usb* and /mnt/ext*", () => {
    expect(isRemovableMount("/mnt/usb0")).toBe(true);
    expect(isRemovableMount("/mnt/usb0/games/x.pkg")).toBe(true);
    expect(isRemovableMount("/mnt/ext1/foo")).toBe(true);
  });

  it("is false for internal + other mounts", () => {
    expect(isRemovableMount("/data/x")).toBe(false);
    expect(isRemovableMount("/user/app")).toBe(false);
    // ShadowMount disc images are internal mounts, NOT removable drives.
    expect(isRemovableMount("/mnt/shadowmnt/PPSA01289/eboot.bin")).toBe(false);
    expect(isRemovableMount("/mnt/ps5upload/img")).toBe(false);
  });
});

describe("removableMountRoot", () => {
  it("extracts the drive root from a deeper path", () => {
    expect(removableMountRoot("/mnt/usb0/games/x.pkg")).toBe("/mnt/usb0");
    expect(removableMountRoot("/mnt/ext1/a/b/c")).toBe("/mnt/ext1");
    expect(removableMountRoot("/mnt/usb0")).toBe("/mnt/usb0");
  });

  it("returns null for non-removable paths", () => {
    expect(removableMountRoot("/data/x")).toBeNull();
    expect(removableMountRoot("/mnt/shadowmnt/g/eboot.bin")).toBeNull();
  });
});
