import type { PageState } from "./types";

const DELETE_PREFIX = "Delete ";

export function visibleTodoNames(page: PageState): string[] {
  return page.actions
    .filter((action) => action.kind === "click" && action.label.startsWith(DELETE_PREFIX))
    .map((action) => action.label.slice(DELETE_PREFIX.length));
}

export function addedTodoNames(before: string[], after: string[]): string[] {
  const remaining = [...before];
  return after.filter((name) => {
    const index = remaining.indexOf(name);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function todoIsCompleted(page: PageState, name: string): boolean {
  return page.actions.some((action) => action.kind === "click" && action.label === `Mark ${name} as active`);
}

export function completedFilterIsSelected(page: PageState): boolean {
  return page.actions.some((action) => action.kind === "click"
    && action.label === "Completed"
    && (action.pressed === true || action.pressed === "true"));
}
