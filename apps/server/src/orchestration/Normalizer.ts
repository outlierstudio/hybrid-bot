import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  HYBRID_BOT_ID, // HYBRID
  HYBRID_DEVELOPER_DIRECT, // HYBRID
  type ClientOrchestrationCommand,
  type UserInputAttachments,
  getProviderAttachmentLimitError,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts"; // HYBRID
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

/** Client-chosen ids must never claim the server: namespace (B4 bypass). */
export const isReservedServerCommandId = (commandId: string): boolean =>
  commandId.startsWith("server:");

/**
 * HYBRID: with Developer directly off, every client chat thread talks to Hybrid. New chat
 * threads (and a draft's bootstrap thread) get Hybrid as partner, and clearing the partner is
 * refused. Pure; the partnerless-thread turn check needs the read model and lives below.
 */
export function applyHybridPartnerRules(
  command: ClientOrchestrationCommand,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): { readonly command: ClientOrchestrationCommand } | { readonly error: string } {
  if (developerDirect) return { command };
  if (command.type === "thread.partner.set" && command.partnerBotId === null) {
    return {
      error: "Threads always talk to Hybrid in this version; the partner can't be cleared.",
    };
  }
  if (command.type === "thread.create" && (command.kind ?? "chat") === "chat") {
    return { command: { ...command, partnerBotId: command.partnerBotId ?? HYBRID_BOT_ID } };
  }
  if (command.type === "thread.turn.start" && command.bootstrap?.createThread !== undefined) {
    const createThread = command.bootstrap.createThread;
    return {
      command: {
        ...command,
        bootstrap: {
          ...command.bootstrap,
          createThread: {
            ...createThread,
            partnerBotId: createThread.partnerBotId ?? HYBRID_BOT_ID,
          },
        },
      },
    };
  }
  return { command };
}

/** A turn on an existing chat thread with no partner (an old T3 thread) is refused. */
export function rejectsPartnerlessTurn(
  thread: { readonly kind?: string | undefined; readonly partnerBotId?: string | null | undefined },
  turnBotId: string | undefined,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): boolean {
  if (developerDirect || turnBotId !== undefined) return false;
  return (thread.kind ?? "chat") === "chat" && (thread.partnerBotId ?? null) === null;
}

export const PARTNERLESS_TURN_MESSAGE =
  "This thread has no partner. Continue it with Hybrid to send messages.";

export type NormalizeDispatchCommandOptions = {
  /** Server-minted commands may use the `server:` commandId namespace. */
  readonly origin?: "client" | "server";
};

export const normalizeDispatchCommand = (
  command: ClientOrchestrationCommand,
  options?: NormalizeDispatchCommandOptions,
) =>
  Effect.gen(function* () {
    if (options?.origin !== "server" && isReservedServerCommandId(command.commandId)) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Command ids reserved for the server cannot be sent by clients.",
      });
    }

    // HYBRID: work threads are created by the developer-task orchestrator only.
    if (
      options?.origin !== "server" &&
      command.type === "thread.create" &&
      command.kind === "work"
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Work threads can only be created by the server.",
      });
    }

    // HYBRID: users only talk to Hybrid (unless Developer directly is on).
    if (options?.origin !== "server") {
      const ruled = applyHybridPartnerRules(command);
      if ("error" in ruled) {
        return yield* new OrchestrationDispatchCommandError({ message: ruled.error });
      }
      command = ruled.command;
      if (command.type === "thread.turn.start" && command.bootstrap?.createThread === undefined) {
        const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
        if (Option.isSome(snapshots)) {
          const thread = yield* snapshots.value
            .getThreadShellById(command.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(thread) && rejectsPartnerlessTurn(thread.value, command.botId)) {
            return yield* new OrchestrationDispatchCommandError({
              message: PARTNERLESS_TURN_MESSAGE,
            });
          }
        }
      }
    }

    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type !== "thread.turn.start" &&
      canonicalCommand.type !== "thread.user-input.respond"
    ) {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachments =
      canonicalCommand.type === "thread.turn.start"
        ? canonicalCommand.message.attachments
        : Object.values(canonicalCommand.attachmentsByQuestionId ?? {}).flat();
    const attachmentLimitError = getProviderAttachmentLimitError(attachments);
    if (attachmentLimitError) {
      return yield* new OrchestrationDispatchCommandError({ message: attachmentLimitError });
    }
    if (canonicalCommand.type === "thread.turn.start") {
      const clientAttachmentIds = new Set<string>();
      for (const attachment of attachments) {
        if (attachment.id === undefined) continue;
        if (clientAttachmentIds.has(attachment.id)) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Attachment '${attachment.name}' cannot be sent: duplicate attachment id.`,
          });
        }
        clientAttachmentIds.add(attachment.id);
      }
    }
    const claimedAttachmentPaths: string[] = [];
    const attachmentsWithDecodedSizes = [...attachments];
    // Context records bind to attachments by the id the client knew; they follow the rename.
    const finalAttachmentIdByClientId = new Map<string, string>();
    const normalizedAttachments = yield* Effect.forEach(
      attachments,
      (attachment, index) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }

            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }

            // Keep the pending copy until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id. A copy, not a
            // hard link: an agent editing the delivered file in place must not
            // mutate the retry source.
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(claim.finalPath);
            finalAttachmentIdByClientId.set(attachment.id, claim.finalId);

            return normalizedAttachment;
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
            ...(attachment.source ? { source: attachment.source } : {}),
          };
          attachmentsWithDecodedSizes[index] = persistedAttachment;
          const decodedLimitError = getProviderAttachmentLimitError(attachmentsWithDecodedSizes);
          if (decodedLimitError) {
            return yield* new OrchestrationDispatchCommandError({ message: decodedLimitError });
          }

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );
          claimedAttachmentPaths.push(attachmentPath);
          if (attachment.id !== undefined) {
            finalAttachmentIdByClientId.set(attachment.id, attachmentId);
          }

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    if (canonicalCommand.type === "thread.user-input.respond") {
      let index = 0;
      const attachmentsByQuestionId = Object.fromEntries(
        Object.entries(canonicalCommand.attachmentsByQuestionId ?? {}).map(
          ([questionId, original]) => {
            const claimed = normalizedAttachments.slice(
              index,
              index + original.length,
            ) as UserInputAttachments[string];
            index += original.length;
            return [questionId, claimed];
          },
        ),
      );
      return {
        ...canonicalCommand,
        ...(attachments.length > 0 ? { attachmentsByQuestionId } : {}),
      };
    }
    const context = canonicalCommand.message.context;
    const normalizedContext =
      context === undefined
        ? undefined
        : {
            ...context,
            records: context.records.map((record) =>
              (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                ? {
                    ...record,
                    attachmentId:
                      finalAttachmentIdByClientId.get(record.attachmentId) ?? record.attachmentId,
                  }
                : record,
            ),
          };
    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
        ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      },
    } satisfies OrchestrationCommand;
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  const originalAttachments =
    command.type === "thread.turn.start"
      ? command.message.attachments
      : command.type === "thread.user-input.respond"
        ? Object.values(command.attachmentsByQuestionId ?? {}).flat()
        : [];
  const normalizedAttachments =
    normalizedCommand.type === "thread.turn.start"
      ? normalizedCommand.message.attachments
      : normalizedCommand.type === "thread.user-input.respond"
        ? Object.values(normalizedCommand.attachmentsByQuestionId ?? {}).flat()
        : [];
  if (normalizedAttachments.length === 0) return;

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    const original = originalAttachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
