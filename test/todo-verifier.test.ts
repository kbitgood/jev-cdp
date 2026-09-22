import { describe, expect, test } from "bun:test";
import {
  addedTodoNames,
  completedFilterIsSelected,
  todoIsCompleted,
  visibleTodoNames,
} from "../src/todo-verifier";
import type { BrowserAction, PageState } from "../src/types";

function page(actions: BrowserAction[]): PageState {
  return {
    url: "http://fixture.test/", title: "Daily List", text: "", w: 100, h: 100,
    scroll: { y: 0, height: 100 }, actions, frames: [], transitions: [], marker: [], page_key: [], guards: {},
    omitted_actions: 0, fingerprint: "fixture",
  };
}

describe("todo verifier", () => {
  test("derives visible todos and preserves duplicate counts", () => {
    const state = page([
      { id: "1", kind: "click", label: "Delete Existing" },
      { id: "2", kind: "click", label: "Delete New" },
      { id: "3", kind: "click", label: "Delete New" },
    ]);
    expect(visibleTodoNames(state)).toEqual(["Existing", "New", "New"]);
    expect(addedTodoNames(["Existing", "New"], visibleTodoNames(state))).toEqual(["New"]);
  });

  test("recognizes completed state from the inverse toggle action", () => {
    expect(todoIsCompleted(page([
      { id: "1", kind: "click", label: "Mark Never tell me the odds as active" },
    ]), "Never tell me the odds")).toBe(true);
  });

  test("requires the completed filter to be visibly pressed", () => {
    expect(completedFilterIsSelected(page([
      { id: "1", kind: "click", label: "Completed", pressed: "true" },
    ]))).toBe(true);
    expect(completedFilterIsSelected(page([
      { id: "1", kind: "click", label: "Completed", pressed: "false" },
    ]))).toBe(false);
  });
});
