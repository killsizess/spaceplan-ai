"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";

export function NewProjectDialog({
  onClose,
  onCreate,
  error,
  busy,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
  error?: string | null;
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("Моя квартира");
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="project-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        className="icon-button modal-close"
        aria-label="Закрыть"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="dialog-symbol">
        <ArrowUpRight size={25} />
      </div>
      <span className="eyebrow">НОВОЕ ПРОСТРАНСТВО</span>
      <h2>С чего начинается ваш план?</h2>
      <p>
        Создайте пустой проект и добавьте первую комнату. Текущий план останется
        в списке «Мои проекты».
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <label htmlFor="project-name">Название проекта</label>
        <input
          id="project-name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          required
          autoFocus
        />
        <button
          className="primary-button"
          type="submit"
          disabled={!name.trim() || busy}
        >
          Создать пустой план <ArrowUpRight size={16} />
        </button>
        {error && (
          <p className="projects-warning" role="alert">
            {error}
          </p>
        )}
      </form>
    </dialog>
  );
}
