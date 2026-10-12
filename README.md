# ASCII Portrait Studio

**English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Español](./README.es.md)

Turn a photo into an animated ASCII portrait in your browser, then export a PNG
or a seamless 6-second video loop. Your photos never leave your device.

**[Try it online →](https://ethannju.github.io/ascii-portrait/)**

https://github.com/user-attachments/assets/ceb3b831-9312-4d70-a9b9-8a16b6d99dea

<sub>[Full-quality video (1080p)](./media/ascii-portrait-demo.mp4)</sub>

## Examples

| Portrait · Original color | Astronaut · Amber | Mecha · Cobalt |
| :-: | :-: | :-: |
| <img src="./assets/demo-portrait.jpg" width="260" alt="Source: portrait"> | <img src="./assets/demo-astronaut.jpg" width="260" alt="Source: astronaut"> | <img src="./assets/demo-mecha.jpg" width="260" alt="Source: mecha"> |
| <img src="./media/examples/portrait-ascii.webp" width="260" alt="ASCII: portrait"> | <img src="./media/examples/astronaut-ascii.webp" width="260" alt="ASCII: astronaut"> | <img src="./media/examples/mecha-ascii.webp" width="260" alt="ASCII: mecha"> |

Top: source image. Bottom: Studio output (grid 8, 19 levels). Click an image for
full size. The three sources are AI-generated demos built into the Studio
([provenance](./assets/PROVENANCE.md)).

## How it works

1. **Brightness → characters.** The photo is sampled on a grid. Each cell's
   brightness picks a glyph from a 19- or 27-level light-to-dense set, and the
   glyph keeps the cell's color (or a Monochrome, Signal green, Amber, or Cobalt palette).
2. **Portrait separation.** An in-browser segmentation model (TensorFlow.js,
   MediaPipe Selfie Segmentation) separates the subject from the background.
   If it is unavailable, the whole photo is used.
3. **Displacement and motion.** A brightness-derived 2D field displaces the image
   with WebGL, and the characters animate on top. No 3D reconstruction is involved.
4. **Frame-exact export.** Video frames are rendered on a fixed timeline and encoded
   with WebCodecs into a 24 fps WebM that loops cleanly. A slow computer takes
   longer to export instead of dropping frames.

## Usage

Open the [online Studio](https://ethannju.github.io/ascii-portrait/), or run it
locally with Node.js 22+ (no dependencies, no build step):

```bash
git clone https://github.com/Ethannju/ascii-portrait.git
cd ascii-portrait
npm run dev        # open http://127.0.0.1:4173
```

1. Drop in a photo, or pick a sample from **Demos**.
2. Adjust grid size, color, displacement, and motion in the Inspector.
3. Choose **PNG still** or **Looping video · 6s**, then click **Export**.

The interface is available in English and Chinese. Video export needs WebCodecs
and has been tested in Chrome 154 and Safari 26.4 on macOS; elsewhere, export a
PNG. Portrait separation downloads its model from a CDN on first use. Run
`npm test` before contributing changes.

Your last photo and settings are saved only in your own browser, so they come
back when you reopen the page. Nothing is uploaded, and other visitors always
start from the default screen. To remove them, click **Clear local data** in the
Inspector's **Scene** section.

### Getting the best result

The Studio turns the light and shadow already in your photo into characters, so
the photo matters more than any setting. The best input is a **studio-lit portrait
on a black background with strong contrast**: one side of the face brightly lit,
the other in deep shadow, and the face large in the frame. Flat, evenly lit
selfies and busy backgrounds turn into noise.

If your photo doesn't look like that, ask an image-generation AI (for example
ChatGPT or Gemini) to relight it first, then upload the result. Example prompt:

> Turn this photo into a low-key studio portrait of the same person. Keep the face,
> identity, hairstyle, and expression unchanged. Pure black seamless background.
> One hard, warm-white key light from the side and slightly above lights the
> forehead, nose, cheekbone, and jaw on one side; the other side of the face falls
> into deep shadow. Add a thin, cool rim light on the hair and shoulder on the dark
> side. Head-and-shoulders crop with the face large in the frame, vertical 4:5.
> Photorealistic, sharp eyes, real skin texture, highlights that keep their detail.
> No text, props, or watermark.

Only use photos of yourself or photos you have permission to use.

## License

Code: [MIT](./LICENSE). Demo images and media: [ASSET-LICENSE.md](./ASSET-LICENSE.md).
