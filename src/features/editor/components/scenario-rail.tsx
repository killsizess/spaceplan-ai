"use client";

import { tr } from "@/lib/i18n";
import { Check, TriangleAlert } from "lucide-react";
import type { ScenarioStep, ScenarioStepId } from "../scenario-steps";

/**
 * The route through the plan, from drawing to report. Each step opens the place where
 * that step is done. The labels of the buttons say "Шаг N", so they never read as the
 * action buttons with the same word.
 */
export function ScenarioRail({
  steps,
  onOpen,
}: {
  steps: readonly ScenarioStep[];
  onOpen: (id: ScenarioStepId) => void;
}) {
  return (
    <nav className="scenario-rail" aria-label={tr`Маршрут по плану`} data-testid="scenario-rail">
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} data-state={step.state} data-step={step.id}>
            <button
              type="button"
              aria-label={tr`Шаг ${index + 1}: ${step.label.toLowerCase()}, ${step.value}`}
              aria-current={step.state === "current" ? "step" : undefined}
              onClick={() => onOpen(step.id)}
            >
              <span className="scenario-mark" aria-hidden="true">
                {step.state === "done" ? <Check size={13} strokeWidth={3} /> : step.state === "attention" ? <TriangleAlert size={12} strokeWidth={2.5} /> : index + 1}
              </span>
              <span className="scenario-text">
                <strong>{step.label}</strong>
                <small>{step.value}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
