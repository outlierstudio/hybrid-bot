#!/usr/bin/env node

// Renders the Android launcher, splash, themed, and notification artwork from the Icon
// Composer eyes layer and the face gradient.
//
// Icon Composer exports already contain a rounded-square silhouette, and Android masks the
// central 72dp of a 108dp adaptive canvas, so exporting them as a foreground would frame the
// icon twice. Instead every channel gets the full-bleed face gradient as the background and the
// eyes as a shared transparent foreground. The Android 12+ splash masks the
// central two thirds of a 288dp canvas, the same proportion the launcher crops, so composing
// the two layers into one 288dp image frames the splash like the launcher icon.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

type IconVariant = "dev" | "nightly" | "prod";

// HYBRID: the icon is the face itself: a full-bleed #F4F4F1 → #DCDCD7 gradient background with
// the eyes (assets/<variant>/app-icon.icon/Assets/eyes.svg) as the foreground. The face's
// 64pt square maps onto the whole 108dp canvas, so the launcher mask cuts the face's shape and
// the eyes keep their place on it (they sit well inside the 72dp safe zone).

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// 24dp at xxxhdpi for the status-bar notification icon.
const NOTIFICATION_CANVAS = 96;
// The face is a 64pt square.
const FACE_SIZE = 64;
// Themed and notification silhouettes: a rounded face with the eyes cut out.
const SILHOUETTE_FRACTION = 0.6;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
export const ANDROID_FACE_GRADIENT = { top: "#F4F4F1", bottom: "#DCDCD7" } as const;

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const faceTransform = (size: number, fraction: number) => {
  const scale = (size * fraction) / FACE_SIZE;
  const offset = (size - FACE_SIZE * scale) / 2;
  return `translate(${offset.toFixed(3)} ${offset.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

const rasterize = (layer: string, svg: string, size: number) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(size, size).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (layer: string, base: Buffer, overlay: Buffer) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([{ input: overlay }])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readEyesLayer = Effect.fn("androidIcons.readEyesLayer")(function* (repositoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(
    path.join(repositoryRoot, "assets", "prod", "app-icon.icon", "Assets", "eyes.svg"),
  );
  return source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
});

/** Full-bleed face gradient; the launcher's mask gives it its shape. */
const renderBackground = (size: number) =>
  rasterize(
    "background",
    canvasSvg(
      size,
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ANDROID_FACE_GRADIENT.top}"/><stop offset="1" stop-color="${ANDROID_FACE_GRADIENT.bottom}"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#g)"/>`,
    ),
    size,
  );

/** Just the eyes, where they sit on a face that fills the canvas. */
const renderForeground = (eyes: string, size: number) =>
  rasterize(
    "foreground",
    canvasSvg(size, `<g transform="${faceTransform(size, 1)}">${eyes}</g>`),
    size,
  );

/** A flat white rounded face with the eyes cut out, for themed and notification icons. */
const renderSilhouette = (eyes: string, size: number, fraction: number, layer: string) => {
  const holes = eyes.replace(/fill="#1C1C1E"/g, 'fill="#000"');
  const mask = `<defs><mask id="eyes"><rect width="64" height="64" fill="#fff"/>${holes}</mask></defs>`;
  const body = `<rect width="64" height="64" rx="22" fill="#fff" mask="url(#eyes)"/>`;
  return rasterize(
    layer,
    canvasSvg(size, `${mask}<g transform="${faceTransform(size, fraction)}">${body}</g>`),
    size,
  );
};

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const eyes = yield* readEyesLayer(repositoryRoot);
  const background = yield* renderBackground(ADAPTIVE_CANVAS);
  const splash = yield* composite(
    "splash",
    yield* renderBackground(SPLASH_CANVAS),
    yield* renderForeground(eyes, SPLASH_CANVAS),
  );
  const variants: ReadonlyArray<IconVariant> = ["dev", "nightly", "prod"];
  const outputs: Array<readonly [string, Buffer]> = [
    ["android-icon-foreground.png", yield* renderForeground(eyes, ADAPTIVE_CANVAS)],
    ...variants.map((variant) => [`android-icon-background-${variant}.png`, background] as const),
    ...variants.map((variant) => [`android-splash-icon-${variant}.png`, splash] as const),
    [
      "android-icon-mark.png",
      yield* renderSilhouette(eyes, ADAPTIVE_CANVAS, SILHOUETTE_FRACTION, "mark"),
    ],
    [
      "android-notification-icon.png",
      yield* renderSilhouette(eyes, NOTIFICATION_CANVAS, 0.85, "notification"),
    ],
  ];
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
