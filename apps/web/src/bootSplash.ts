/**
 * HYBRID: hands the boot splash over to the app.
 *
 * Before React replaces #root, the splash is lifted into a fixed overlay. Once the sidebar
 * header's face is on screen, the splash face glides (FLIP: one transform from its own box
 * to the target's) onto it, then the overlay fades out and is removed. With reduced motion,
 * or when there is no visible target (narrow layouts, collapsed sidebar), it only fades.
 */
const TARGET_SELECTOR = "[data-hybrid-face-target]";
const TARGET_WAIT_MS = 2500;
const GLIDE_MS = 520;
const FADE_MS = 220;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function visibleRect(element: Element | null): DOMRect | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  const onScreen =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth;
  return onScreen ? rect : null;
}

function waitForTarget(): Promise<DOMRect | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + TARGET_WAIT_MS;
    const tick = () => {
      const rect = visibleRect(document.querySelector(TARGET_SELECTOR));
      if (rect !== null || performance.now() > deadline) resolve(rect);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Call right before the first React render. Safe to call when there is no splash. */
export function liftBootSplash(): void {
  const shell = document.getElementById("boot-shell");
  if (shell === null || shell.querySelector("#boot-error") !== null) return;
  shell.classList.add("boot-lifted");
  document.body.append(shell);
  void handOff(shell);
}

async function handOff(shell: HTMLElement): Promise<void> {
  const logo = shell.querySelector<SVGElement>("#boot-shell-logo");
  const target = prefersReducedMotion() ? null : await waitForTarget();
  if (logo !== null && target !== null && typeof logo.animate === "function") {
    const from = logo.getBoundingClientRect();
    const dx = target.left + target.width / 2 - (from.left + from.width / 2);
    const dy = target.top + target.height / 2 - (from.top + from.height / 2);
    const scale = target.width / from.width;
    await logo
      .animate(
        [
          { transform: "translate(0, 0) scale(1)" },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        ],
        { duration: GLIDE_MS, easing: EASE_OUT, fill: "forwards" },
      )
      .finished.catch(() => undefined);
  }
  if (typeof shell.animate === "function") {
    await shell
      .animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: prefersReducedMotion() ? 120 : FADE_MS,
        easing: "ease-out",
        fill: "forwards",
      })
      .finished.catch(() => undefined);
  }
  shell.remove();
}
