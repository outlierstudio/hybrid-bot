import { HYBRID_BOT_COLOR } from "@t3tools/contracts";
import { useEffect, useId, useRef } from "react";

import { cn } from "../lib/utils";

/** HYBRID: Hybrid's face is the brand mark (brand/hybrid-bot.svg): a gray-white gradient, graphite eyes. */
export const HYBRID_FACE = { top: "#F4F4F1", bottom: "#DCDCD7", eyes: "#1C1C1E" } as const;

/** How far the eyes travel, in face units (the face is 64 wide). */
const GAZE_REACH = 3;
/** Where the eyes rest while a task runs: down toward the work card below. */
const WORK_GLANCE = { x: 1.5, y: 3 } as const;
const BLINK_MIN_MS = 4000;
const BLINK_MAX_MS = 9000;
const BLINK_MS = 160;

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A small colored face. The eyes are cut out so the partner reads as a character, not a status dot.
 *
 * Motion is opt-in per placement and transform-only: `gaze="cursor"` follows the pointer
 * (empty state), `gaze="work"` glances toward the work card, `blink` blinks every 4–9s, and
 * `attention` hops once each time it turns on (a card needs the user). Nothing moves under
 * prefers-reduced-motion, and pointer tracking writes styles directly, never React state.
 */
export function PartnerFace(props: {
  readonly color: string;
  readonly className?: string;
  /** Eyes travel up and down while the partner is still thinking. */
  readonly looking?: boolean;
  readonly gaze?: "cursor" | "work" | null;
  readonly blink?: boolean;
  readonly attention?: boolean;
}) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const gazeRef = useRef<SVGGElement>(null);
  const blinkRef = useRef<SVGGElement>(null);
  const isHybrid = props.color.toUpperCase() === HYBRID_BOT_COLOR.toUpperCase();
  const { gaze = null, blink = false, attention = false } = props;

  // Eyes follow the cursor, one style write per animation frame at most.
  useEffect(() => {
    const group = gazeRef.current;
    const svg = svgRef.current;
    if (group === null || svg === null) return;
    if (gaze !== "cursor" || reducedMotion()) {
      group.style.transform =
        gaze === "work" && !reducedMotion()
          ? `translate(${WORK_GLANCE.x}px, ${WORK_GLANCE.y}px)`
          : "";
      return;
    }
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const apply = () => {
      frame = 0;
      if (pointer === null) return;
      const box = svg.getBoundingClientRect();
      const dx = pointer.x - (box.left + box.width / 2);
      const dy = pointer.y - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      // Full reach once the pointer is a few face-widths away.
      const reach = GAZE_REACH * Math.min(1, distance / (box.width * 3));
      group.style.transform = `translate(${((dx / distance) * reach).toFixed(2)}px, ${((dy / distance) * reach).toFixed(2)}px)`;
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame !== 0) cancelAnimationFrame(frame);
      group.style.transform = "";
    };
  }, [gaze]);

  // A blink every 4–9 seconds.
  useEffect(() => {
    const group = blinkRef.current;
    if (!blink || group === null || reducedMotion()) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          group.classList.add("partner-blinking");
          timer = setTimeout(() => {
            group.classList.remove("partner-blinking");
            schedule();
          }, BLINK_MS);
        },
        BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS),
      );
    };
    schedule();
    return () => {
      clearTimeout(timer);
      group.classList.remove("partner-blinking");
    };
  }, [blink]);

  // One squash-and-stretch hop each time attention turns on.
  useEffect(() => {
    const svg = svgRef.current;
    if (!attention || svg === null || reducedMotion()) return;
    svg.classList.remove("partner-hop");
    // Restart the animation even if a previous hop class is still on.
    void svg.getBoundingClientRect();
    svg.classList.add("partner-hop");
    const done = () => svg.classList.remove("partner-hop");
    svg.addEventListener("animationend", done, { once: true });
    return () => svg.removeEventListener("animationend", done);
  }, [attention]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("shrink-0", props.looking && "partner-looking", props.className)}
    >
      {isHybrid ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={HYBRID_FACE.top} />
            <stop offset="1" stopColor={HYBRID_FACE.bottom} />
          </linearGradient>
        </defs>
      ) : null}
      <rect width="64" height="64" rx="22" fill={isHybrid ? `url(#${gradientId})` : props.color} />
      <g ref={gazeRef} className="partner-gaze">
        <g ref={blinkRef} className="partner-blink">
          <g className="partner-eyes" fill={isHybrid ? HYBRID_FACE.eyes : "rgba(0,0,0,0.78)"}>
            <rect x="15" y="26" width="9" height="16" rx="4.5" transform="rotate(-14 19.5 34)" />
            <rect x="38" y="24" width="9" height="16" rx="4.5" transform="rotate(-18 42.5 32)" />
          </g>
        </g>
      </g>
    </svg>
  );
}
