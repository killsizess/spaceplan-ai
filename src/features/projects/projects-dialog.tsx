"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, FolderOpen, GitBranch, Pencil, Plus, RotateCcw, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { getTotalArea } from "@/domain/floor-plan/operations";
import { countsInTotal, type FloorPlan } from "@/domain/floor-plan/types";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { resolveWallRoomLabels } from "@/domain/floor-plan/wall-room-labels";
import { wallKindOf } from "@/domain/floor-plan/wall-kind";
import { rulesForPlan } from "@/domain/rules/engine";
import { PROCEDURES } from "@/domain/rules/moscow";
import { formatArea, pluralRu } from "@/lib/format";
import type { SavedProject, TrashedProject } from "./project-repository";
import "./projects-dialog.css";

function PlanThumbnail({
  plan,
  wallRooms,
}: {
  plan: FloorPlan;
  wallRooms: readonly WallRoom[];
}) {
  const underlay = plan.underlay?.visible ? plan.underlay : undefined;
  const manualRooms = plan.roomMode === "walls" ? [] : plan.rooms;
  if (
    !manualRooms.length &&
    !wallRooms.length &&
    !plan.walls.length &&
    !underlay
  )
    return (
      <div className="project-thumbnail blank">
        <Plus size={22} strokeWidth={1} />
      </div>
    );
  const points = manualRooms.flatMap((room) => [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y + room.height },
  ]);
  points.push(...wallRooms.flatMap((room) => room.outer));
  points.push(...plan.walls.flatMap((wall) => [wall.start, wall.end]));
  if (underlay)
    points.push(
      { x: underlay.x, y: underlay.y },
      {
        x: underlay.x + underlay.pixelWidth * underlay.metersPerPixel,
        y: underlay.y + underlay.pixelHeight * underlay.metersPerPixel,
      },
    );
  const minX = Math.min(...points.map((p) => p.x)),
    minY = Math.min(...points.map((p) => p.y));
  const width = Math.max(0.1, Math.max(...points.map((p) => p.x)) - minX);
  const height = Math.max(0.1, Math.max(...points.map((p) => p.y)) - minY);
  const pad = Math.max(width, height) * 0.1;
  return (
    <div className="project-thumbnail">
      <svg
        viewBox={`${minX - pad} ${minY - pad} ${width + 2 * pad} ${height + 2 * pad}`}
        aria-hidden="true"
      >
        {underlay && (
          <image
            href={underlay.dataUrl}
            x={underlay.x}
            y={underlay.y}
            width={underlay.pixelWidth * underlay.metersPerPixel}
            height={underlay.pixelHeight * underlay.metersPerPixel}
            opacity={underlay.opacity}
          />
        )}
        {wallRooms.map((room) => (
          <path
            key={room.id}
            d={[room.outer, ...room.holes]
              .map(
                (ring) =>
                  ring
                    .map(
                      (point, index) =>
                        `${index === 0 ? "M" : "L"}${point.x},${point.y}`,
                    )
                    .join(" ") + " Z",
              )
              .join(" ")}
            fill={room.color}
            fillRule="evenodd"
            fillOpacity={underlay ? 0.4 : 1}
            stroke="#6a7d63"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {manualRooms.map((room) => (
          <rect
            key={room.id}
            x={room.x}
            y={room.y}
            width={room.width}
            height={room.height}
            fill={room.color}
            fillOpacity={underlay ? 0.4 : 1}
            stroke="#6a7d63"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {plan.walls.map((wall) => (
          <line
            key={wall.id}
            x1={wall.start.x}
            y1={wall.start.y}
            x2={wall.end.x}
            y2={wall.end.y}
            stroke="#465c46"
            strokeWidth={wall.thickness}
          />
        ))}
      </svg>
    </div>
  );
}

interface Props {
  projects: SavedProject[];
  trash: TrashedProject[];
  currentId: string;
  unreadableCount: number;
  notice: string | null;
  busy: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onRename: (id: string, name: string, expectedRevision: string) => Promise<boolean>;
  onTrash: (id: string, expectedRevision: string) => Promise<boolean>;
  onRestore: (id: string, expectedRevision: string) => Promise<boolean>;
  /** Saves records that could not be read as they are, so they can be repaired. */
  onSaveUnreadable?: () => void;
}

function planPreview(plan: FloorPlan) {
  if (plan.roomMode !== "walls") {
    return {
      wallRooms: [] as readonly WallRoom[],
      area: getTotalArea(plan),
      count: plan.rooms.length,
      problem: null as string | null,
    };
  }
  try {
    const { rooms } = resolveWallRoomLabels(plan);
    return {
      wallRooms: rooms,
      area: rooms.filter((room) => countsInTotal(room.kind)).reduce((sum, room) => sum + room.area, 0),
      count: rooms.length,
      problem: null as string | null,
    };
  } catch (cause) {
    return {
      wallRooms: [] as readonly WallRoom[],
      area: 0,
      count: 0,
      problem: cause instanceof Error ? cause.message : "Не удалось определить помещения.",
    };
  }
}
function ProjectPreview({ saved }: { saved: SavedProject | TrashedProject }) {
  const preview = useMemo(() => planPreview(saved.plan), [saved.plan]);
  const procedure = useMemo(() => (saved.plan.origin ? rulesForPlan(saved.plan)?.overall ?? null : null), [saved.plan]);
  const unknownWalls = saved.plan.walls.filter((wall) => wallKindOf(wall) === "unknown").length;
  const deleted = saved.storageVersion === 2;
  const date = deleted ? saved.trashedAt : saved.updatedAt;
  return <>
    <PlanThumbnail plan={saved.plan} wallRooms={preview.wallRooms} />
    <div className="saved-project-details">
      <h3 title={saved.plan.name}>{saved.plan.name}</h3>
      {preview.problem ? (
        <p className="saved-project-warning" data-testid="project-warning" title={preview.problem}>
          <TriangleAlert size={12} aria-hidden="true" /> Помещения не определены: {preview.problem}
        </p>
      ) : (
        <p>{pluralRu(preview.count, "помещение", "помещения", "помещений")} <span>·</span> {formatArea(preview.area)}</p>
      )}
      {saved.plan.origin && (
        <p className="saved-project-origin" data-testid="project-origin">
          <GitBranch size={12} aria-hidden="true" /> Вариант плана «{saved.plan.origin.planName}»
        </p>
      )}
      {procedure && (
        <p className="saved-project-note" data-testid="project-procedure" data-procedure={procedure}>
          По нормам: {PROCEDURES[procedure].label.toLowerCase()}
        </p>
      )}
      {unknownWalls > 0 && (
        <p className="saved-project-note" data-testid="project-unknown-walls">
          Без типа: {pluralRu(unknownWalls, "стена", "стены", "стен")} из {saved.plan.walls.length}
        </p>
      )}
      <time dateTime={date}>
        {deleted ? "Удалён " : "Изменён "}
        {new Intl.DateTimeFormat("ru-RU", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        }).format(new Date(date))}
      </time>
    </div>
  </>;
}

type LibraryAction = { kind: "rename" | "trash"; id: string; revision: string; name: string; pending: boolean };

export function ProjectsDialog({
  projects,
  trash,
  currentId,
  unreadableCount,
  notice,
  busy,
  onClose,
  onOpen,
  onNew,
  onImport,
  onRename,
  onTrash,
  onRestore,
  onSaveUnreadable,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"projects" | "trash">("projects");
  const [action, setAction] = useState<LibraryAction | null>(null);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  if (action && !action.pending && projects.find((saved) => saved.plan.id === action.id)?.revision !== action.revision) {
    setAction(null);
    setFormError("");
    setActionNotice("Проект изменился. Проверьте актуальную запись и повторите действие.");
  }
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  function close() {
    ref.current?.close();
    onClose();
  }
  function begin(kind: LibraryAction["kind"], saved: SavedProject) {
    setAction({ kind, id: saved.plan.id, revision: saved.revision, name: saved.plan.name, pending: false });
    setDraft(saved.plan.name);
    setFormError("");
    setActionNotice("");
  }
  function switchView(next: typeof view) {
    setView(next);
    setAction(null);
    setFormError("");
    setActionNotice("");
  }
  return (
    <dialog
      ref={ref}
      className="projects-dialog"
      aria-labelledby="projects-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <button
        className="icon-button modal-close"
        aria-label="Закрыть мои проекты"
        onClick={close}
      >
        <X size={18} />
      </button>
      <span className="eyebrow">ВАША БИБЛИОТЕКА ПРОСТРАНСТВ</span>
      <h2 id="projects-title">
        Мои проекты <span>{projects.length}</span>
      </h2>
      <p className="projects-description">
        Планы сохраняются в этом браузере. Экспортируйте JSON, чтобы сделать
        резервную копию или перенести проект на другое устройство.
      </p>
      <div className="library-toolbar">
        <div className="library-switch" aria-label="Разделы библиотеки">
          <button aria-label="Проекты" aria-pressed={view === "projects"} onClick={() => switchView("projects")}>
            <FolderOpen size={15} /> Проекты <span>{projects.length}</span>
          </button>
          <button aria-label="Корзина" aria-pressed={view === "trash"} onClick={() => switchView("trash")}>
            <Trash2 size={15} /> Корзина <span>{trash.length}</span>
          </button>
        </div>
        <div className="projects-actions">
          <button className="primary-button" disabled={busy} onClick={onNew}>
            <Plus size={15} /> Новый проект
          </button>
          <button className="secondary-button" disabled={busy} onClick={onImport}>
            <Upload size={15} /> Импорт JSON
          </button>
        </div>
      </div>
      {notice && <div className="projects-warning library-notice" data-testid="library-notice" role="alert">{notice}</div>}
      {actionNotice && <div className="projects-warning" role="status">{actionNotice}</div>}
      {unreadableCount > 0 && (
        <div className="projects-warning" role="status">
          Не удалось прочитать записей: {unreadableCount}. Они оставлены в
          хранилище без изменений.{" "}
          {onSaveUnreadable && (
            <button type="button" className="text-button" onClick={onSaveUnreadable}>
              Скачать эти записи
            </button>
          )}
        </div>
      )}
      {view === "trash" && <p className="library-trash-description">Здесь хранятся удалённые проекты. Восстановление вернёт план в библиотеку вместе с комнатами, стенами и подложкой.</p>}
      <div className="project-grid">
        {view === "projects" && projects.map((saved) => {
          const editing = action?.id === saved.plan.id ? action : null;
          return (
            <article
              key={saved.plan.id}
              className={`saved-project ${saved.plan.id === currentId ? "current" : ""}`}
              data-testid="saved-project"
              data-project-id={saved.plan.id}
            >
              <ProjectPreview saved={saved} />
              <div className="saved-project-controls">
                {saved.plan.id === currentId ? <span className="current-project-badge">Открыт сейчас</span> : (
                  <button className="open-project-button" aria-label={`Открыть ${saved.plan.name}`} onClick={() => onOpen(saved.plan.id)} disabled={busy}>
                    Открыть <ArrowUpRight size={15} />
                  </button>
                )}
                <div className="saved-project-management">
                  <button className="library-icon-button" title="Переименовать проект" aria-label={`Переименовать ${saved.plan.name}`} disabled={busy} onClick={() => begin("rename", saved)}><Pencil size={15} /></button>
                  <button className="library-icon-button library-trash-button" title="Переместить в корзину" aria-label={`В корзину ${saved.plan.name}`} disabled={busy} onClick={() => begin("trash", saved)}><Trash2 size={15} /></button>
                </div>
              </div>
              {editing?.kind === "rename" && <form className="library-inline-form" noValidate onSubmit={(event) => {
                event.preventDefault();
                const name = draft.trim();
                if (!name || name.length > 100) {
                  setFormError(!name ? "Введите название проекта." : "Название — не больше 100 символов.");
                  return;
                }
                setFormError("");
                setAction({ ...editing, pending: true });
                void onRename(editing.id, name, editing.revision).then((success) => {
                  setAction((current) => current?.id === editing.id && current.revision === editing.revision
                    ? success ? null : { ...current, pending: false } : current);
                });
              }}>
                <label htmlFor="library-project-name">Новое название проекта</label>
                <input id="library-project-name" value={draft} disabled={busy} autoFocus aria-invalid={Boolean(formError)} aria-describedby={formError ? "library-name-error" : undefined} onChange={(event) => { setDraft(event.target.value); setFormError(""); }} />
                {formError && <p id="library-name-error" role="alert" className="library-form-error">{formError}</p>}
                <div className="library-form-actions">
                  <button type="button" className="library-cancel" aria-label="Отменить переименование" disabled={busy} onClick={() => setAction(null)}>Отмена</button>
                  <button type="submit" className="library-submit" disabled={busy}><Check size={14} /> Сохранить название</button>
                </div>
              </form>}
              {editing?.kind === "trash" && <div className="library-trash-confirm" role="group" aria-label="Подтверждение удаления проекта">
                <p>Переместить «{editing.name}» в корзину?</p>
                <span>Вы сможете восстановить его из раздела «Корзина».{saved.plan.id === currentId ? " Редактор откроет другой проект или новый пустой план." : ""}</span>
                <div className="library-form-actions">
                  <button className="library-cancel" aria-label="Отмена удаления" disabled={busy} onClick={() => setAction(null)}>Отмена</button>
                  <button className="library-delete-submit" disabled={busy} onClick={() => {
                    setAction({ ...editing, pending: true });
                    void onTrash(editing.id, editing.revision).then((success) => {
                      setAction((current) => current?.id === editing.id && current.revision === editing.revision
                        ? success ? null : { ...current, pending: false } : current);
                    });
                  }}><Trash2 size={14} /> Переместить в корзину</button>
                </div>
              </div>}
            </article>
          );
        })}
        {view === "trash" && trash.map((saved) => <article key={saved.plan.id} className="saved-project trashed-project" data-testid="trashed-project" data-project-id={saved.plan.id}>
          <ProjectPreview saved={saved} />
          <button className="library-restore" aria-label={`Восстановить ${saved.plan.name}`} disabled={busy} onClick={() => { void onRestore(saved.plan.id, saved.revision); }}>
            <RotateCcw size={15} /> Восстановить
          </button>
        </article>)}
      </div>
      {view === "projects" && !projects.length && (
        <div className="projects-empty">
          <FolderOpen size={30} strokeWidth={1} />
          <h3>Место для ваших идей</h3>
          <p>Создайте первый проект или импортируйте план из JSON.</p>
        </div>
      )}
      {view === "trash" && !trash.length && <div className="projects-empty">
        <Trash2 size={30} strokeWidth={1} />
        <h3>Корзина пуста</h3>
        <p>Удалённые проекты появятся здесь.</p>
      </div>}
    </dialog>
  );
}
