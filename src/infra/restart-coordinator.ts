import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkBlocker,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import { scheduleGatewayRestart, type ScheduledRestart } from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR2
// restarts, while still allowing explicit deferral bypasses for operators.
type SafeGatewayRestartBlocker = Omit<GatewayActiveWorkBlocker, "kind"> & {
  kind:
    | "queue"
    | "reply"
    | "embedded-run"
    | "cron-run"
    | "background-exec"
    | "root-request"
    | "agent-run"
    | "acp-run"
    | "media-generation";
};

type SafeRestartInspectors = Pick<
  GatewayActiveWorkInspectors,
  | "getQueueSize"
  | "getPendingReplies"
  | "getEmbeddedRuns"
  | "getCronRuns"
  | "getBackgroundExecSessions"
  | "getRootRequests"
  | "getAgentRuns"
  | "getAcpRuns"
  | "getMediaRuns"
  | "getSessionAdmissions"
  | "getSessionMutations"
  | "getChatRuns"
  | "getQueuedTurns"
  | "getTerminalPersistence"
  | "getTerminalSessions"
>;

export type SafeGatewayRestartRequestResult = {
  ok: true;
  status: "scheduled" | "deferred" | "coalesced";
  preflight: ReturnType<typeof createSafeGatewayRestartPreflight>;
  restart: ScheduledRestart;
};

export function createSafeGatewayRestartPreflight(inspectors: Partial<SafeRestartInspectors> = {}) {
  // Pass caller inspectors through untouched: createGatewayActiveWorkSnapshot already defaults
  // the session classes to the live counters (getSessionControllerWorkCount/getSessionMutationCount).
  // Shadowing them with literal zeros here blinded the preflight to in-flight session work.
  const snapshot = createGatewayActiveWorkSnapshot(inspectors);
  const counts = {
    queueSize: snapshot.counts.queueSize,
    pendingReplies: snapshot.counts.pendingReplies,
    embeddedRuns: snapshot.counts.embeddedRuns,
    cronRuns: snapshot.counts.cronRuns,
    backgroundExecSessions: snapshot.counts.backgroundExecSessions,
    rootRequests: snapshot.counts.rootRequests,
    agentRuns: snapshot.counts.agentRuns,
    acpRuns: snapshot.counts.acpRuns,
    mediaRuns: snapshot.counts.mediaRuns,
    sessionAdmissions: snapshot.counts.sessionAdmissions,
    sessionMutations: snapshot.counts.sessionMutations,
  };
  const totalActive = Object.values(counts).reduce((total, count) => total + count, 0);
  const blockers = snapshot.blockers as SafeGatewayRestartBlocker[];
  const safe = totalActive === 0;

  const summary = safe
    ? "safe to restart now"
    : blockers.length > 0
      ? `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`
      : "restart deferred: active session work";
  return {
    safe,
    counts: { ...counts, totalActive },
    blockers,
    summary,
  };
}

/** Schedule a gateway restart after collecting tracked active-work blockers. */
export function scheduleSafeGatewayRestart(
  opts: {
    reason?: string;
    delayMs?: number;
    skipDeferral?: boolean;
    inspect?: Partial<SafeRestartInspectors>;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  const skipDeferral = opts.skipDeferral === true;
  const restart = scheduleGatewayRestart({
    delayMs: opts.delayMs ?? 0,
    reason: opts.reason ?? "gateway.restart.safe",
    ...(skipDeferral ? { preservePendingEmitHooksOnDeferralBypass: true, skipDeferral: true } : {}),
  });
  const status = restart.coalesced
    ? "coalesced"
    : skipDeferral || preflight.safe
      ? "scheduled"
      : "deferred";
  return {
    ok: true,
    status,
    preflight,
    restart,
  };
}
