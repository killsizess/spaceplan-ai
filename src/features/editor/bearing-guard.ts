import { bearingWallChanges, type BearingChange } from "@/domain/floor-plan/wall-kind";
import { editorReducer, type EditorAction, type EditorState } from "./editor-state";

const CHANGE_TEXT: Record<BearingChange, string> = {
  deleted: "будет удалена",
  moved: "будет перенесена или изменится её длина",
  thickness: "изменится толщина",
  unmarked: "перестанет считаться несущей",
};

/** Actions that restore or replace a plan as a whole are the user's explicit choice, not an edit of a wall. */
const EXEMPT = new Set<EditorAction["type"]>(["load", "select", "clearError", "undo", "redo", "replace"]);

/**
 * Warning text when `action` would change a wall marked bearing, otherwise null. The
 * action is previewed with the real reducer, so the warning is shown exactly when the
 * edit would succeed and exactly for the walls it would touch. Plans without bearing
 * walls cost nothing.
 */
export function bearingChangeMessage(state: EditorState, action: EditorAction): string | null {
  if (EXEMPT.has(action.type) || !state.plan.walls.some((wall) => wall.kind === "bearing")) return null;
  const next = editorReducer(state, action);
  if (next.plan === state.plan) return null;
  const changes = bearingWallChanges(state.plan, next.plan);
  if (!changes.length) return null;
  const list = changes.map((item) => `Стена ${item.number}: ${CHANGE_TEXT[item.change]}`).join("\n");
  return [
    changes.length === 1 ? "Вы меняете несущую стену." : `Вы меняете несущие стены: ${changes.length}.`,
    list,
    "Это может нарушить конструкцию здания. Отмена вернёт всё как было (шаг можно отменить и после изменения). Продолжить?",
  ].join("\n\n");
}
