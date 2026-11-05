import {
  createEmptyPlan,
  createExamplePlan,
} from "@/domain/floor-plan/operations";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import {
  editorReducer,
  initialEditorState,
  type EditorAction,
  type EditorState,
} from "@/features/editor/editor-state";
import {
  readUnreadableRecords,
  ACTIVE_PROJECT_KEY,
  listProjects,
  parsePlanFile,
  ProjectConflictError,
  ProjectTrashedError,
  readProject,
  readTrashedProject,
  renameProject as renameSavedProject,
  restoreProject as restoreSavedProject,
  saveProject,
  trashProject as trashSavedProject,
  type SavedProject,
  type StorageLike,
  type TrashedProject,
} from "./project-repository";

export type SaveStatus = "loading" | "saving" | "saved" | "error" | "conflict";
export interface WorkspaceSnapshot {
  editor: EditorState;
  projects: SavedProject[];
  trash: TrashedProject[];
  unreadableCount: number;
  ready: boolean;
  status: SaveStatus;
  storageError: string | null;
  notice: string | null;
  busy: boolean;
}
interface Services {
  storage: StorageLike;
  newId: () => string;
  now: () => string;
  withLock: (key: string, work: () => void) => Promise<void>;
}

function errorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "QuotaExceededError" || error.name === "SecurityError")
  ) {
    return "Браузер не смог сохранить проект: хранилище недоступно или заполнено. План остаётся открыт — экспортируйте его в JSON.";
  }
  return error instanceof Error
    ? error.message
    : "Не удалось сохранить проект. Экспортируйте его в JSON.";
}

/** Application state and persistence coordination. No React or browser globals. */
export class ProjectWorkspace {
  private snapshot: WorkspaceSnapshot = {
    editor: initialEditorState(createExamplePlan()),
    projects: [],
    trash: [],
    unreadableCount: 0,
    ready: false,
    status: "loading",
    storageError: null,
    notice: null,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private services: Services | null = null;
  private revision: string | null = null;
  private savedPlan: FloorPlan | null = null;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<WorkspaceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private refreshList() {
    if (this.services) this.publish(listProjects(this.services.storage));
  }
  initialize(services: Services) {
    if (this.initialized) return;
    this.initialized = true;
    this.services = services;
    try {
      const library = listProjects(services.storage);
      const activeId = services.storage.getItem(ACTIVE_PROJECT_KEY);
      const active =
        library.projects.find((saved) => saved.plan.id === activeId) ??
        library.projects[0];
      const plan = active?.plan ?? {
        ...createExamplePlan(),
        id: services.newId(),
      };
      this.revision = active?.revision ?? null;
      this.savedPlan = active ? plan : null;
      this.publish({
        ...library,
        editor: initialEditorState(plan),
        ready: true,
        status: active ? "saved" : "saving",
        // User data must not go missing without a word.
        ...(library.unreadableCount > 0
          ? { notice: `Не удалось прочитать проектов: ${library.unreadableCount}. Записи не тронуты: откройте «Мои проекты», там их можно скачать.` }
          : {}),
      });
      if (!active) this.scheduleSave();
    } catch (error) {
      this.failInitialization(error);
    }
  }
  failInitialization(error: unknown) {
    this.publish({
      ready: true,
      status: "error",
      storageError: errorMessage(error),
    });
  }
  dispatch = (action: EditorAction) => {
    if (!this.snapshot.ready || this.snapshot.busy) return;
    const previous = this.snapshot.editor;
    const editor = editorReducer(previous, action);
    this.publish({ editor });
    if (editor.plan !== previous.plan) this.scheduleSave();
  };
  private scheduleSave() {
    if (!this.services || this.snapshot.status === "conflict") return;
    const services = this.services,
      plan = this.snapshot.editor.plan,
      generation = this.generation;
    this.publish({ status: "saving", storageError: null });
    this.queue = this.queue
      .then(async () => {
        if (
          generation !== this.generation ||
          this.snapshot.status === "conflict"
        )
          return;
        await services.withLock(`spaceplan-ai:save:${plan.id}`, () => {
          if (
            generation !== this.generation ||
            this.snapshot.status === "conflict"
          )
            return;
          const saved = saveProject(
            services.storage,
            plan,
            this.revision,
            services.newId(),
            services.now(),
          );
          this.revision = saved.revision;
          this.savedPlan = plan;
          services.storage.setItem(ACTIVE_PROJECT_KEY, plan.id);
          this.refreshList();
          if (this.snapshot.editor.plan === plan)
            this.publish({ status: "saved", storageError: null });
        });
      })
      .catch((error: unknown) => {
        if (generation === this.generation)
          this.publish({
            status:
              error instanceof ProjectConflictError ? "conflict" : "error",
            storageError: errorMessage(error),
          });
      });
  }
  flush = async () => {
    await this.queue;
  };
  retrySave = () => {
    if (!this.snapshot.busy && this.snapshot.status !== "conflict") this.scheduleSave();
  };
  dismissNotice = () => this.publish({ notice: null });
  reportNotice = (notice: string) => this.publish({ notice });
  /** Unreadable records as stored; empty when there are none. */
  unreadableRecords = () => (this.services ? readUnreadableRecords(this.services.storage) : []);
  hasUnsavedChanges = () => this.snapshot.editor.plan !== this.savedPlan;

  private async ensureSavedBeforeSwitch() {
    await this.flush();
    if (this.hasUnsavedChanges())
      throw new Error(
        "Текущие изменения не сохранены. Повторите сохранение или сохраните копию перед переходом к другому проекту.",
      );
  }
  private async ensureCurrentCanChange() {
    await this.ensureSavedBeforeSwitch();
    if (this.snapshot.status === "conflict") throw new ProjectConflictError();
  }
  private reportLibraryFailure(error: unknown, id: string) {
    // A stale dialog may simply contain an older revision of our own save. Only
    // mark the working copy conflicted if its actual stored revision changed.
    if (
      error instanceof ProjectConflictError &&
      id === this.snapshot.editor.plan.id &&
      this.services
    ) {
      try {
        const current = readProject(this.services.storage, id);
        if (current?.revision !== this.revision)
          this.publish({ status: "conflict", storageError: error.message });
      } catch {
        // The original operation error remains the actionable explanation.
      }
    }
    try {
      this.refreshList();
    } catch {
      // Do not replace the original failure with a secondary library read error.
    }
    const storageFailure = error instanceof Error &&
      (error.name === "QuotaExceededError" || error.name === "SecurityError");
    this.reportNotice(storageFailure
      ? "Не удалось изменить библиотеку: хранилище браузера недоступно или заполнено. Сохранённая запись проекта не изменена."
      : errorMessage(error));
  }
  private load(saved: SavedProject) {
    this.generation++;
    this.revision = saved.revision;
    this.savedPlan = saved.plan;
    this.publish({
      editor: initialEditorState(saved.plan),
      status: "saved",
      storageError: null,
      notice: null,
    });
  }
  openProject = async (id: string): Promise<boolean> => {
    if (!this.services || this.snapshot.busy) return false;
    this.publish({ busy: true });
    try {
      await this.ensureSavedBeforeSwitch();
      const saved = readProject(this.services.storage, id);
      if (!saved) throw new Error("Проект больше не найден в браузере.");
      this.services.storage.setItem(ACTIVE_PROJECT_KEY, id);
      this.load(saved);
      return true;
    } catch (error) {
      this.reportNotice(errorMessage(error));
      return false;
    } finally {
      this.publish({ busy: false });
    }
  };
  renameProject = async (
    id: string,
    name: string,
    expectedRevision: string,
  ): Promise<boolean> => {
    if (!this.services || this.snapshot.busy) return false;
    const services = this.services;
    const isCurrent = id === this.snapshot.editor.plan.id;
    this.publish({ busy: true, notice: null });
    try {
      if (isCurrent) await this.ensureCurrentCanChange();
      else await this.flush();
      await services.withLock(`spaceplan-ai:save:${id}`, () => {
        if (isCurrent && this.snapshot.status === "conflict")
          throw new ProjectConflictError();
        const saved = renameSavedProject(
          services.storage, id, name, expectedRevision,
          services.newId(), services.now(),
        );
        if (isCurrent) {
          const withName = (plan: FloorPlan): FloorPlan =>
            plan.name === saved.plan.name ? plan : { ...plan, name: saved.plan.name };
          const editor = this.snapshot.editor;
          const plan = withName(editor.plan);
          this.revision = saved.revision;
          this.savedPlan = plan;
          this.publish({
            editor: {
              ...editor, plan,
              past: editor.past.map(withName),
              future: editor.future.map(withName),
            },
            status: "saved", storageError: null,
          });
        }
      });
      try {
        this.refreshList();
      } catch (error) {
        this.reportNotice(`Название проекта изменено. ${errorMessage(error)}`);
      }
      return true;
    } catch (error) {
      this.reportLibraryFailure(error, id);
      return false;
    } finally {
      this.publish({ busy: false });
    }
  };
  /** The tombstone is committed before selecting any replacement working plan. */
  private leaveTrashedProject() {
    if (!this.services) return;
    const services = this.services;
    let fallback: SavedProject | undefined;
    const notices: string[] = [];
    try {
      const library = listProjects(services.storage);
      this.publish(library);
      fallback = library.projects[0];
    } catch (error) {
      notices.push(errorMessage(error));
    }
    if (fallback) this.load(fallback);
    else {
      const plan = createEmptyPlan(services.newId());
      this.generation++;
      this.revision = null;
      this.savedPlan = null;
      this.publish({
        editor: initialEditorState(plan), status: "saving",
        storageError: null, notice: null,
      });
    }
    try {
      services.storage.setItem(ACTIVE_PROJECT_KEY, this.snapshot.editor.plan.id);
    } catch {
      notices.push(
        "Проект перемещён в корзину. Не удалось запомнить выбор другого проекта; открытый план сохранён в памяти.",
      );
    }
    if (!fallback) this.scheduleSave();
    if (notices.length > 0) this.reportNotice(notices.join(" "));
  }
  trashProject = async (
    id: string,
    expectedRevision: string,
  ): Promise<boolean> => {
    if (!this.services || this.snapshot.busy) return false;
    const services = this.services;
    const isCurrent = id === this.snapshot.editor.plan.id;
    this.publish({ busy: true, notice: null });
    try {
      if (isCurrent) await this.ensureCurrentCanChange();
      else await this.flush();
      await services.withLock(`spaceplan-ai:save:${id}`, () => {
        if (isCurrent && this.snapshot.status === "conflict")
          throw new ProjectConflictError();
        trashSavedProject(
          services.storage, id, expectedRevision,
          services.newId(), services.now(),
        );
      });
    } catch (error) {
      this.reportLibraryFailure(error, id);
      this.publish({ busy: false });
      return false;
    }
    // Once committed, a failed active-pointer write must never report a failed
    // deletion or leave the just-trashed plan open as the active working copy.
    if (isCurrent) this.leaveTrashedProject();
    else {
      try {
        this.refreshList();
      } catch (error) {
        this.reportNotice(`Проект перемещён в корзину. ${errorMessage(error)}`);
      }
    }
    this.publish({ busy: false });
    return true;
  };
  restoreProject = async (
    id: string,
    expectedRevision: string,
  ): Promise<boolean> => {
    if (!this.services || this.snapshot.busy) return false;
    const services = this.services;
    this.publish({ busy: true, notice: null });
    try {
      await this.flush();
      await services.withLock(`spaceplan-ai:save:${id}`, () => {
        restoreSavedProject(
          services.storage, id, expectedRevision,
          services.newId(), services.now(),
        );
      });
      try {
        this.refreshList();
      } catch (error) {
        this.reportNotice(`Проект восстановлен. ${errorMessage(error)}`);
      }
      return true;
    } catch (error) {
      this.reportLibraryFailure(error, id);
      return false;
    } finally {
      this.publish({ busy: false });
    }
  };
  private async createFrom(
    plan: FloorPlan,
    allowUnsaved = false,
  ): Promise<boolean> {
    if (!this.services || this.snapshot.busy) return false;
    const services = this.services;
    this.publish({ busy: true });
    try {
      if (allowUnsaved) await this.flush();
      else await this.ensureSavedBeforeSwitch();
      const copy = { ...plan, id: services.newId() };
      let saved: SavedProject | null = null;
      await services.withLock(`spaceplan-ai:save:${copy.id}`, () => {
        saved = saveProject(
          services.storage,
          copy,
          null,
          services.newId(),
          services.now(),
        );
      });
      if (!saved) throw new Error("Не удалось создать проект.");
      // The project record is already committed. A failed active-pointer write
      // must not leave recovery via saveCopy looking unsuccessful or hidden.
      this.load(saved);
      const notices: string[] = [];
      try {
        this.refreshList();
      } catch (error) {
        this.publish({
          projects: [saved, ...this.snapshot.projects.filter((project) => project.plan.id !== copy.id)],
        });
        notices.push(`Проект сохранён. ${errorMessage(error)}`);
      }
      try {
        services.storage.setItem(ACTIVE_PROJECT_KEY, copy.id);
      } catch {
        notices.push(
          "Проект сохранён и открыт. Не удалось запомнить его выбор в браузере; сохранённый проект доступен в библиотеке.",
        );
      }
      if (notices.length > 0) this.reportNotice(notices.join(" "));
      return true;
    } catch (error) {
      this.reportNotice(errorMessage(error));
      return false;
    } finally {
      this.publish({ busy: false });
    }
  }
  createProject = (name: string) =>
    this.createFrom({ ...createEmptyPlan("new"), name });
  createExample = () => this.createFrom(createExamplePlan());
  importProject = async (text: string) => {
    try {
      return await this.createFrom(parsePlanFile(text));
    } catch (error) {
      this.reportNotice(errorMessage(error));
      return false;
    }
  };
  /**
   * A layout variant is a separate project copied from the current plan: the
   * current project is saved first and stays unchanged in the library; the
   * variant opens with a new ID and starts its own history.
   */
  createVariant = () => {
    const plan = this.snapshot.editor.plan;
    return this.createFrom({
      ...plan,
      name: `${plan.name.slice(0, 88)} · вариант`,
      // The variant remembers its source and a snapshot of it, so a comparison still works
      // after the source is edited or deleted.
      ...(this.services ? { origin: createPlanOrigin(plan, this.services.now()) } : {}),
    });
  };
  /** Saves a generated plan as a variant of the open plan, the same way a hand-made one is. */
  createGeneratedVariant = (plan: FloorPlan, index: number) => {
    const source = this.snapshot.editor.plan;
    return this.createFrom({
      ...plan,
      name: `${source.name.slice(0, 80)} · подбор ${index}`,
      ...(this.services ? { origin: createPlanOrigin(source, this.services.now()) } : {}),
    });
  };
  saveCopy = () =>
    this.createFrom(
      {
        ...this.snapshot.editor.plan,
        name: `${this.snapshot.editor.plan.name.slice(0, 90)} — копия`,
      },
      true,
    );
  reloadSaved = async (): Promise<boolean> => {
    if (!this.services || this.snapshot.busy) return false;
    this.publish({ busy: true });
    try {
      await this.flush();
      const saved = readProject(
        this.services.storage,
        this.snapshot.editor.plan.id,
      );
      if (!saved)
        throw new Error(
          "Сохранённая версия не найдена. Экспортируйте текущий план или сохраните копию.",
        );
      this.load(saved);
      return true;
    } catch (error) {
      this.reportNotice(errorMessage(error));
      return false;
    } finally {
      this.publish({ busy: false });
    }
  };
  syncFromOtherTab = () => {
    if (!this.services || !this.snapshot.ready) return;
    try {
      this.refreshList();
      if (!this.savedPlan) return;
      const current = readProject(
        this.services.storage,
        this.snapshot.editor.plan.id,
      );
      if (current?.revision !== this.revision) {
        const conflict = !current && readTrashedProject(
          this.services.storage, this.snapshot.editor.plan.id,
        ) ? new ProjectTrashedError() : new ProjectConflictError();
        this.publish({
          status: "conflict",
          storageError: conflict.message,
        });
      }
    } catch (error) {
      this.publish({ status: "error", storageError: errorMessage(error) });
    }
  };
}
