import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
  NoxSpotResolutionTemplateSchema,
  renderResolutionTemplate,
  resolutionEmailFontStacks,
  resolutionTemplateFromWidgetConfig,
  resolutionTemplateRevision,
} from "../noxspot-resolution-template.js";

describe("NoxSpot resolution templates", () => {
  it("uses the safe default for missing or invalid site configuration", () => {
    expect(resolutionTemplateFromWidgetConfig(null)).toMatchObject({
      template: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      usingDefault: true,
    });
    expect(resolutionTemplateFromWidgetConfig('{"resolutionEmail":{"subject":"broken"}}').usingDefault).toBe(true);
  });

  it("upgrades older saved templates with safe branding defaults", () => {
    const { senderName: _senderName, appearance: _appearance, ...legacy } = DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE;
    const resolved = resolutionTemplateFromWidgetConfig(JSON.stringify({ resolutionEmail: legacy }));
    expect(resolved.usingDefault).toBe(false);
    expect(resolved.template).toMatchObject({
      senderName: "NoxSpot",
      appearance: DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE.appearance,
    });
  });

  it("renders only the supported variables", () => {
    const rendered = renderResolutionTemplate(DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE, {
      report_title: "Checkout failed",
      site_name: "Playnist",
    });
    expect(rendered.subject).toBe("Resolved: Checkout failed");
    expect(rendered.closing).toBe("Thank you again for helping us improve Playnist.");
  });

  it("rejects unknown or malformed variables", () => {
    expect(NoxSpotResolutionTemplateSchema.safeParse({
      ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      subject: "Resolved for {{reporter_email}}",
    }).success).toBe(false);
    expect(NoxSpotResolutionTemplateSchema.safeParse({
      ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      subject: "Resolved: {{report_title}",
    }).success).toBe(false);
    expect(NoxSpotResolutionTemplateSchema.safeParse({
      ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      appearance: { ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE.appearance, accentColor: "red" },
    }).success).toBe(false);
    expect(NoxSpotResolutionTemplateSchema.safeParse({
      ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE,
      senderName: "Playnist\nBcc: victim@example.com",
    }).success).toBe(false);
  });

  it("produces stable revisions that change with the template", async () => {
    const first = await resolutionTemplateRevision(DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE);
    const same = await resolutionTemplateRevision({ ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE });
    const changed = await resolutionTemplateRevision({ ...DEFAULT_NOXSPOT_RESOLUTION_TEMPLATE, tone: "formal" });
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  it("keeps every font preset safe for double-quoted inline styles", () => {
    for (const preset of ["system", "playnist", "humanist", "editorial", "mono"]) {
      const fonts = resolutionEmailFontStacks(preset);
      expect(fonts.heading).not.toContain('"');
      expect(fonts.body).not.toContain('"');
    }
  });
});
