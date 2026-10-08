# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project is the face itself (`../brand/hybrid-bot-app-icon-v2.svg`): `background.svg`, a full-bleed `#F4F4F1` → `#DCDCD7` gradient, and `eyes.svg`, the two eyes on the 64-unit face grid at scale 16. The icon has no corners of its own; the system mask shapes it. All three channels share the same artwork.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.

> HYBRID: the current generated PNGs and ICOs (macOS included) were rendered with `sharp` on a
> machine without Icon Composer: iOS and the apple-touch icon full bleed from
> `../brand/hybrid-bot-app-icon-v2.svg`; Linux, Windows, and favicons from `../brand/hybrid-bot.svg`
> as is; macOS as an 824×824 rounded body inset 100px. They have no Icon Composer shadow. The next `vp run icons:export` on a Mac with
> Icon Composer 2 replaces them with native renditions; `icons:check` cannot pass before that.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette would get framed again. `vp run icons:export:android` renders the
Android artwork from the prod `eyes.svg` layer and the face gradient instead:

- `apps/mobile/assets/android-icon-foreground.png`: the eyes, placed as on a face that fills the canvas
- `apps/mobile/assets/android-icon-background-{dev,nightly,prod}.png`: the full-bleed face gradient
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image
- `apps/mobile/assets/android-icon-mark.png` and `android-notification-icon.png`: a flat white
  silhouette with the eyes cut out, for themed and status-bar icons

Rerun the export after changing the eyes layer.
