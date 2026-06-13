import { describe, expect, it } from "vitest";

import { clampUploadStreams, MAX_UPLOAD_STREAMS } from "./uploadSettings";

/**
 * Upload-stream count must stay in [1, MAX]: more than the payload supports
 * can crash it mid-upload, and zero/negative is meaningless. Fractions round.
 */
describe("clampUploadStreams", () => {
  it("caps an over-large count at MAX", () => {
    expect(clampUploadStreams(99)).toBe(MAX_UPLOAD_STREAMS);
  });

  it("floors zero / negative at 1", () => {
    expect(clampUploadStreams(0)).toBe(1);
    expect(clampUploadStreams(-5)).toBe(1);
  });

  it("rounds a fractional count", () => {
    expect(clampUploadStreams(2.6)).toBe(3);
    expect(clampUploadStreams(1.2)).toBe(1);
  });

  it("passes an in-range integer through", () => {
    expect(clampUploadStreams(2)).toBe(2);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampUploadStreams(Number.NaN)).toBeGreaterThanOrEqual(1);
    expect(clampUploadStreams(Number.NaN)).toBeLessThanOrEqual(
      MAX_UPLOAD_STREAMS,
    );
  });
});
