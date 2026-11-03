"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ProjectWorkspace } from "./project-workspace";
import { PROJECT_PREFIX } from "./project-repository";

export function useProjectWorkspace() {
  const [workspace] = useState(() => new ProjectWorkspace());
  const snapshot = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
    workspace.getSnapshot,
  );
  useEffect(() => {
    try {
      workspace.initialize({
        storage: window.localStorage,
        newId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        withLock: (key, work) =>
          navigator.locks
            ? navigator.locks.request(key, work)
            : Promise.resolve().then(work),
      });
    } catch (error) {
      workspace.failInitialization(error);
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PROJECT_PREFIX))
        workspace.syncFromOtherTab();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (workspace.hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [workspace]);
  return { workspace, snapshot };
}
