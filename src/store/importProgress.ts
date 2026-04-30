// Module-scoped store for the doc-import progress UI.
//
// The import runs in `pickAndImportDocx()` and reports progress here. The
// modal+dock components subscribe via useSyncExternalStore. The store
// outlives the modal so the user can dismiss the modal ("continue in
// background") without aborting the import — the dock keeps reflecting
// state until the run finishes or errors out.

import { useSyncExternalStore } from "react";

export type StepStatus = "pending" | "active" | "done" | "error";

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
}

export interface ProgressState {
  /** True between startImport() and dismiss(). */
  active: boolean;
  /** True when the user clicked "continue in background" — modal hides,
   *  dock shows. */
  minimized: boolean;
  steps: Step[];
  /** 0..1, derived from done-step count + active-step partial. */
  overall: number;
  error: string | null;
  /** Set on success — used by the dock to show a "view" affordance after
   *  import finishes. */
  resultBookId: string | null;
  /** Bumps when the run finishes (success or error) so the dock can flash
   *  the completion state briefly before auto-hiding. */
  finishedAt: number | null;
}

const initial: ProgressState = {
  active: false,
  minimized: false,
  steps: [],
  overall: 0,
  error: null,
  resultBookId: null,
  finishedAt: null,
};

let state: ProgressState = initial;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<ProgressState>) {
  state = { ...state, ...patch };
  emit();
}

function recomputeOverall(steps: Step[]): number {
  if (steps.length === 0) return 0;
  let done = 0;
  let active = 0;
  for (const s of steps) {
    if (s.status === "done") done++;
    else if (s.status === "active") active++;
  }
  // Active counts as half-done so the bar advances during long steps.
  return Math.min(1, (done + active * 0.5) / steps.length);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): ProgressState {
  return state;
}

export function useImportProgress(): ProgressState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ── actions ───────────────────────────────────────────────────────────────

export function startImport(steps: { id: string; label: string }[]): void {
  const expanded: Step[] = steps.map((s) => ({ ...s, status: "pending" }));
  state = {
    active: true,
    minimized: false,
    steps: expanded,
    overall: 0,
    error: null,
    resultBookId: null,
    finishedAt: null,
  };
  emit();
}

export function beginStep(id: string): void {
  const steps = state.steps.map((s) => {
    if (s.id === id) return { ...s, status: "active" as const };
    // Anything still "active" when we move on gets implicitly marked done —
    // covers the case where a stage forgot to call completeStep before
    // beginning the next one.
    if (s.status === "active") return { ...s, status: "done" as const };
    return s;
  });
  set({ steps, overall: recomputeOverall(steps) });
}

export function completeStep(id: string): void {
  const steps = state.steps.map((s) =>
    s.id === id ? { ...s, status: "done" as const } : s,
  );
  set({ steps, overall: recomputeOverall(steps) });
}

export function failStep(id: string, message: string): void {
  const steps = state.steps.map((s) =>
    s.id === id ? { ...s, status: "error" as const } : s,
  );
  set({
    steps,
    overall: recomputeOverall(steps),
    error: message,
    finishedAt: Date.now(),
  });
}

export function finishImport(resultBookId: string): void {
  // Mark every remaining step done so the bar lands at 100% even if a
  // stage forgot to call completeStep.
  const steps = state.steps.map((s) =>
    s.status === "pending" || s.status === "active"
      ? { ...s, status: "done" as const }
      : s,
  );
  set({
    steps,
    overall: 1,
    resultBookId,
    finishedAt: Date.now(),
  });
}

export function setMinimized(minimized: boolean): void {
  set({ minimized });
}

/** Reset to idle. Used after the user dismisses a finished/errored run, or
 *  to clear stale state before starting a new import. */
export function dismiss(): void {
  state = initial;
  emit();
}
