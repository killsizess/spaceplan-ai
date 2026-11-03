import { useEffect } from "react";
import type { EditorAction } from "./editor-state";
import type { EditorTool } from "./editor-tools";

export interface EditorShortcutOptions {
  /** A dialog is open or the workspace is not ready: no shortcut may act. */
  blocked: boolean;
  selectedId: string | null;
  /** The selection is a room derived from walls, which cannot be deleted directly. */
  wallRoomSelected: boolean;
  wallMode: boolean;
  viewMode: "2d" | "3d";
  dispatch: (action: EditorAction) => void;
  reportNotice: (message: string) => void;
  enter2D: (tool?: EditorTool) => void;
  setTool: (tool: EditorTool) => void;
  fit: () => void;
  closePopovers: () => void;
}

/** Keyboard shortcuts of the editor; Russian layout keys mirror the Latin ones. */
export function useEditorShortcuts({
  blocked,
  selectedId,
  wallRoomSelected,
  wallMode,
  viewMode,
  dispatch,
  reportNotice,
  enter2D,
  setTool,
  fit,
  closePopovers,
}: EditorShortcutOptions) {
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input,select,textarea,dialog") ||
          target.isContentEditable)
      )
        return;
      if (blocked) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (key === "delete" && selectedId) {
          event.preventDefault();
          if (wallRoomSelected)
            reportNotice(
              "Помещение определяется стенами. Измените или удалите стену, чтобы изменить его контур.",
            );
          else dispatch({ type: "delete", id: selectedId });
        }
        if (key === "v" || key === "м") setTool("select");
        if (key === "r" || key === "к") {
          if (wallMode) dispatch({ type: "roomMode:set", mode: "manual" });
          enter2D("room");
        }
        if (key === "h" || key === "р") enter2D("pan");
        if (key === "w" || key === "ц") enter2D("wall");
        if (key === "d" || key === "в") enter2D("door");
        if ((key === "f" || key === "а") && viewMode === "2d") fit();
        if (key === "escape") {
          setTool("select");
          dispatch({ type: "select", id: null });
          closePopovers();
        }
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [blocked, selectedId, wallRoomSelected, wallMode, viewMode, dispatch, reportNotice, enter2D, setTool, fit, closePopovers]);
}
