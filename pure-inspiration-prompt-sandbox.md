# Pure Inspiration Prompt Sandbox

Review-only prompt candidates. This file is not loaded by Muralizer and does not change generation behavior.

## Candidate Selection Injections

The interpretation mode remains the primary composition and treatment control. These selections are candidates only when they can independently improve surface character without competing with the reference image.

| Selection | Candidate | Proposed prompt injection | Rationale |
| --- | --- | --- | --- |
| Application Style | Yes | Add `in a {applicationStyle} application style` to the first outcome sentence. | Stability gives the opening rendering instruction disproportionate weight; place a deliberately selected application style beside the painted outcome, before source facts and composition. |
| Substrate Texture | Yes | `Let the texture of {substrateTexture} subtly inform the painted surface without implying a physical wall or room.` | Adds controlled material character without changing composition. |
| Surface Finish | Later, test separately | `Use a {finish} painted surface treatment.` | Can support metallic, reflective, or matte work, but may conflict with the reference's light and reflection behavior. |
| Color Mode / palettes | No, initially | None | Pure Inspiration should preserve the supplied palette; independent color controls are likely to undermine that promise. |
| Feel | No, initially | None | Broad mood terms overlap the interpretation mode and could make results less predictable. |
| Category / Sub-scene / Elements | No | None | These compete directly with the reference subject and composition. |
| Fog / Panel Type | No | None | Neither contributes reliable art-direction value to a reference-led image. |

## Prompt Authority And Order

Stability prompt order is functional. Earlier content establishes the image's authority hierarchy; later content should only refine it.

1. **Outcome and selected Application Style:** Establish the new image as hand-painted, then add a selected application style in the same first sentence. An Auto application state contributes nothing.
2. **Selected Category/Sub-Scene or assessed background:** A deliberate Category/Sub-Scene selection replaces the assessment's background. Without a selection, use the AI-assessed background.
3. **Global painterly rules:** Keep the two-dimensional, non-photographic contract before supporting details.
4. **Assessment facts:** Keep foreground and composition concise and subordinate. Subject belongs in the opening outcome sentence for AI-guided mode.
5. **Substrate Texture and optional brief:** Append only when deliberately selected. `None` is an explicit no-texture choice; `Auto (use inspiration)` contributes nothing.

### AI-Guided Runtime Shape

```text
Create an original, hand-painted decorative image in a {applicationStyle} application style. Use visible, controlled brushwork, layered opaque color, simplified painted forms, and non-photorealistic light. Give the subject, {assessedSubject}, an intentional setting of {selectedSceneOrAssessedBackground}.

The image must read as a designed two-dimensional painting...

Foreground: {assessedForeground}

Composition: {assessedComposition}

Let the texture of {substrateTexture} subtly inform the painted surface without implying a physical wall or room.
```

Omit any line whose control is Auto or not selected. Do not emit internal control values in the prompt.

## Shared Source Guidance

Create an original, elegant, hand-painted image inspired by the supplied reference image. Preserve its central subject, compositional character, and palette without copying it literally.

## Subdued

Create a quiet, refined, contemporary hand-painted image with softened silhouettes, gentle transitions, restrained contrast, simplified detail, and calm matte color fields. Use subtle, loosely controlled brushwork and an understated sense of light. Keep the composition clear and graceful; avoid photographic rendering, hard graphic edges, visual clutter, and ornate detail.

## Balanced

Create an elegant, contemporary hand-painted image with clear composition, harmonious color, visible but controlled brushwork, balanced silhouettes, and subtle non-photorealistic light. Use polished painterly color fields with a refined level of detail and moderate contrast. Keep the image composed and legible; avoid photographic rendering, visual clutter, and ornate detail.

## Sleek

Create a sleek, contemporary hand-painted image with bold clean silhouettes, sharp deliberate edges and lines, simplified geometry, polished color fields, and controlled visible brushwork. Treat its gleams and reflections subtly rather than realistically, capturing the play of light and shadow across its curves and edges. Use a refined modern editorial design language with crisp focal forms and controlled contrast; avoid photographic rendering, weathering, visual clutter, and ornate detail.

## Inkline

Create an edgy, sleekly modern, contemporary hand-painted image in inkline application type, with bright and bold clean silhouettes, sharp deliberate edges and lines, simplified geometry, polished color fields, and controlled tight brushwork. Treat its shines, gleams, and reflections stylistically - emphasizing and dramatizing them greatly.
