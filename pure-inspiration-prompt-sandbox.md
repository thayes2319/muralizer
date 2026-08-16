# Pure Inspiration Prompt Sandbox

Review-only prompt candidates. This file is not loaded by Muralizer and does not change generation behavior.

## Candidate Selection Injections

The interpretation mode remains the primary composition and treatment control. These selections are candidates only when they can independently improve surface character without competing with the reference image.

| Selection | Candidate | Proposed prompt injection | Rationale |
| --- | --- | --- | --- |
| Application Style | Yes | `Use {applicationStyle} as the application style.` | Directly controls mark-making and rendering technique while preserving the supplied subject and composition. |
| Substrate Texture | Yes | `Let the texture of {substrateTexture} subtly inform the painted surface without implying a physical wall or room.` | Adds controlled material character without changing composition. |
| Surface Finish | Later, test separately | `Use a {finish} painted surface treatment.` | Can support metallic, reflective, or matte work, but may conflict with the reference's light and reflection behavior. |
| Color Mode / palettes | No, initially | None | Pure Inspiration should preserve the supplied palette; independent color controls are likely to undermine that promise. |
| Feel | No, initially | None | Broad mood terms overlap the interpretation mode and could make results less predictable. |
| Category / Sub-scene / Elements | No | None | These compete directly with the reference subject and composition. |
| Fog / Panel Type | No | None | Neither contributes reliable art-direction value to a reference-led image. |

## Intended Runtime Shape

For every Pure Inspiration mode, append only the active, approved injections after that mode's interpretation paragraph:

`{modeDirection} Use {applicationStyle} as the application style. Let the texture of {substrateTexture} subtly inform the painted surface without implying a physical wall or room.`

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
