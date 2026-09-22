import { describe, expect, test } from "bun:test";
import { fingerprint } from "../src/browser";
import { actionSpace, validateChoice, validateTextOutput } from "../src/model";
import type { BrowserAction, ChoiceAnswer, PageState } from "../src/types";

function answer(ids: string[], selected: string): ChoiceAnswer {
  return {
    choice: selected,
    confidence: 1,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
  };
}

describe("TypeSafe response validation", () => {
  test("accepts a complete normalized choice", () => {
    expect(validateChoice(answer(["a", "b"], "a"), ["a", "b"]).choice).toBe("a");
  });

  test.each([
    { name: "unknown choice", mutate: (value: ChoiceAnswer) => { value.choice = "unknown"; } },
    { name: "missing probability", mutate: (value: ChoiceAnswer) => { delete value.probabilities.b; } },
    { name: "negative probability", mutate: (value: ChoiceAnswer) => { value.probabilities.b = -1; } },
    { name: "non-maximum choice", mutate: (value: ChoiceAnswer) => {
      value.choice = "b";
      value.probabilities = { a: 0.8, b: 0.2 };
    } },
    { name: "invalid confidence", mutate: (value: ChoiceAnswer) => { value.confidence = 2; } },
  ])("rejects $name", ({ mutate }) => {
    const value = answer(["a", "b"], "a");
    mutate(value);
    expect(() => validateChoice(value, ["a", "b"])).toThrow("Invalid TypeSafe response");
  });
});

test("action space uses one element index with operation-specific targets", () => {
  const actions: BrowserAction[] = [
    { id: "e1", kind: "fill", label: "Search", role: "textbox", value: "", node: 10 },
    { id: "e2", kind: "click", label: "Open Search", role: "textbox", value: "", node: 10 },
    { id: "e3", kind: "click", label: "Go", role: "button", value: "", pressed: "true", node: 20 },
    { id: "wait", kind: "wait", label: "Wait" },
  ];
  const space = actionSpace(actions);
  expect(space.elements).toHaveLength(2);
  expect(space.elements[0]?.operations).toEqual(["TYPE_TEXT", "CLICK"]);
  expect(space.targets.TYPE_TEXT?.["1"]?.id).toBe("e1");
  expect(space.targets.CLICK?.["1"]?.id).toBe("e2");
  expect(space.targets.CLICK?.["2"]?.id).toBe("e3");
  expect(space.elements[1]?.pressed).toBe("true");
  expect(space.controls.WAIT?.id).toBe("wait");
});

test("identical node numbers in parent and child frames remain separate targets", () => {
  const space = actionSpace([
    { id: "e1", kind: "click", label: "Class", role: "link", node: 1, frameUrl: "https://moodle.test/" },
    { id: "e2", kind: "click", label: "Class", role: "link", node: 1, frameId: "child",
      frameUrl: "https://spero.test/class", nearbyText: "Social Studies 10" },
  ]);
  expect(space.elements).toHaveLength(2);
  expect(space.targets.CLICK?.["1"]?.id).toBe("e1");
  expect(space.targets.CLICK?.["2"]?.id).toBe("e2");
  expect(space.elements[1]?.frameUrl).toBe("https://spero.test/class");
});

test("covered controls remain visible in semantic output but are not click targets", () => {
  const space = actionSpace([{ id: "e1", kind: "click", label: "Class", role: "link", node: 1,
    clickable: false, coveredBy: { tag: "div", text: "Overlay", role: null } }]);
  expect(space.elements[0]?.clickable).toBe(false);
  expect(space.elements[0]?.coveredBy).toEqual({ tag: "div", text: "Overlay", role: null });
  expect(space.targets.CLICK).toBeUndefined();
});

describe("text helper validation", () => {
  test("accepts exactly one non-empty text field", () => {
    expect(validateTextOutput({ text: "Never tell me the odds" })).toBe("Never tell me the odds");
  });

  test.each([
    null,
    { text: "" },
    { text: null },
    { text: "hello", extra: true },
    { text: 123 },
  ])("rejects invalid output %#", (value) => {
    expect(() => validateTextOutput(value)).toThrow("nothing typed");
  });
});

test("fingerprint tracks semantic state but not screenshots", () => {
  const page = {
    url: "https://example.test/",
    title: "Example",
    text: "Example",
    w: 100,
    h: 100,
    scroll: { y: 0, height: 100 },
    actions: [{ id: "e1", kind: "click", label: "Go", node: 1 } as BrowserAction],
    frames: [], transitions: [],
    marker: [],
    page_key: [],
    guards: {},
    omitted_actions: 0,
    fingerprint: "",
  } satisfies PageState;
  const original = fingerprint(page);
  const withScreenshot = { ...page, screenshot: "different" };
  expect(fingerprint(withScreenshot)).toBe(original);
  expect(fingerprint({ ...page, actions: [{ ...page.actions[0]!, node: 2 }] })).not.toBe(original);
});
