import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { thumbPathFor } from "@/lib/photo-thumbs";

describe("thumbPathFor — where a photo's grid thumbnail lives", () => {
  it("keeps the job id as the first segment, so job-scoped storage policies still apply", () => {
    expect(thumbPathFor("abc-123/simpro-99-site.jpg")).toBe("abc-123/thumbs/simpro-99-site.jpg");
    expect(thumbPathFor("abc-123/thumbs/x.jpg").split("/")[0]).toBe("abc-123");
  });

  it("keeps nested names intact", () => {
    expect(thumbPathFor("job/variations/a.jpg")).toBe("job/thumbs/variations/a.jpg");
  });

  it("is identical in the web and mobile copies", () => {
    const body = (f: string) => readFileSync(f, "utf8").replace(/^\/\/.*$/gm, "").trim();
    expect(body("mobile/lib/photoThumbs.ts")).toBe(body("lib/photo-thumbs.ts"));
  });
});
