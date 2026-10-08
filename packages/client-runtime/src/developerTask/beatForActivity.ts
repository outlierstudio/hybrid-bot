/**
 * HYBRID: re-export of the shared beat mapper so web and mobile take it from
 * `@t3tools/client-runtime` as AUDIT §5.5 specifies.
 */
export {
  BEAT_IDLE_THRESHOLD_MS,
  beatForActivity,
  LIVE_STATUS_COALESCE_MS,
  type BeatActivity,
  type BeatPendingKind,
} from "@t3tools/shared/beatForActivity";
