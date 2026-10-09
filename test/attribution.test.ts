import { describe, expect, it } from "vitest";
import { resolveAttribution } from "../src/attribution.js";

const mappings = {
  coupons: new Map([
    ["MARIA10", "creator_01"],
    ["JOAO15", "creator_02"],
  ]),
  utms: new Map([
    ["creator_01", "creator_01"],
    ["creator_02", "creator_02"],
  ]),
};

describe("resolveAttribution", () => {
  it("prefers a known coupon when coupon and UTM point to different creators", () => {
    expect(resolveAttribution("maria10", "creator_02", mappings)).toEqual({
      creatorId: "creator_01",
      source: "coupon",
    });
  });

  it("uses a known UTM when the coupon is missing or unknown", () => {
    expect(resolveAttribution(null, "creator_02", mappings)).toEqual({
      creatorId: "creator_02",
      source: "utm",
    });
    expect(resolveAttribution("UNKNOWN", "creator_02", mappings)).toEqual({
      creatorId: "creator_02",
      source: "utm",
    });
  });

  it("returns no attribution when neither signal is known", () => {
    expect(resolveAttribution("", "", mappings)).toEqual({ creatorId: null, source: "none" });
  });

  it("trims coupon and UTM values before looking them up", () => {
    expect(resolveAttribution("  MARIA10  ", " creator_02 ", mappings)).toEqual({
      creatorId: "creator_01",
      source: "coupon",
    });
  });
});
