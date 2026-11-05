"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { isExamplePlan } from "@/domain/floor-plan/operations";
import type { FloorPlan } from "@/domain/floor-plan/types";

/**
 * A short "where to start" for someone who has just opened the app and is looking at the
 * built-in example. It sits in the page's flow and covers nothing. Once hidden it stays
 * hidden in this browser; that is a convenience, so a blocked storage just shows it again.
 */
const KEY = "spaceplan-ai:welcome-hidden:v1";

const examplePlans = new Set<string>();

/**
 * A plan that opened as the example keeps the strip while it is edited. If renaming it or
 * drawing the first wall took the strip away, the canvas would change size and the camera
 * would jump under the person's hands; only the button or another project removes it.
 */
export function startedAsExample(plan: Pick<FloorPlan, "id" | "name" | "walls">): boolean {
  if (isExamplePlan(plan)) examplePlans.add(plan.id);
  return examplePlans.has(plan.id);
}
const listeners = new Set<() => void>();

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
function hide() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Nothing to do: it comes back on the next visit.
  }
  sessionHidden = true;
  for (const listener of listeners) listener();
}
let sessionHidden = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function WelcomeStrip({ onExample, onUpload }: { onExample: () => void; onUpload: () => void }) {
  const hidden = useSyncExternalStore(subscribe, () => sessionHidden || readHidden(), () => true);
  if (hidden) return null;
  return (
    <section className="welcome-strip" aria-label="С чего начать" data-testid="welcome-strip">
      <p>
        <strong>С чего начать.</strong> Это учебный план без стен. Загрузите чертёж или нарисуйте стены,
        отметьте несущие и нажмите «X-Ray»: он покажет, что можно изменить и что для этого понадобится.
      </p>
      <div>
        <button type="button" className="secondary-button" onClick={onUpload}>Загрузить чертёж</button>
        <button type="button" className="primary-button" onClick={onExample}>Посмотреть на примере</button>
        <button type="button" className="icon-button" aria-label="Скрыть подсказку" onClick={hide}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
