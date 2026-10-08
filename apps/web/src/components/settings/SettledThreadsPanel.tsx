import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { SettingsPageContainer } from "./settingsLayout";

export function SettledThreadsPanel() {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const settled = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null && thread.settledOverride === "settled")
        .toSorted((left, right) =>
          (right.settledAt ?? right.updatedAt).localeCompare(left.settledAt ?? left.updatedAt),
        ),
    [threads],
  );

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1 px-3 py-4 sm:px-4">
        <h1 className="text-sm font-medium">Settled</h1>
        <p className="pb-2 text-sm text-muted-foreground">Chats you wrapped up.</p>
        {settled.length === 0 ? (
          <p className="text-sm text-muted-foreground">No settled chats.</p>
        ) : (
          settled.map((thread) => (
            <button
              key={`${thread.environmentId}:${thread.id}`}
              type="button"
              className="flex h-9 items-center rounded-md px-2 text-left text-sm hover:bg-muted"
              onClick={() => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: thread.environmentId,
                    threadId: thread.id,
                  },
                });
              }}
            >
              <span className="min-w-0 truncate">{thread.title}</span>
            </button>
          ))
        )}
      </div>
    </SettingsPageContainer>
  );
}
