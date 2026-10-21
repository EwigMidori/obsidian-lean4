// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeanDiagnostic } from "../../src/application/contracts";
import { LeanGoalPresenter, LeanIconButton, LeanMessagePresenter } from "../../src/obsidian/LeanFeedback";
import { ObsidianDom, setLanguage } from "./fixtures/ObsidianApiStub";

describe("Lean feedback presentation", () => {
  beforeEach(() => { ObsidianDom.install(); setLanguage("zh"); });
  afterEach(() => { setLanguage("en"); document.body.replaceChildren(); });

  it("keeps severity, position and selectable raw information in separate elements", () => {
    const message = '10\n<script>alert("literal Lean output")</script>';
    const diagnostic: LeanDiagnostic = {
      severity: "information", message,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
    };
    const card = LeanMessagePresenter.render(document.body, diagnostic);
    expect(card.classList.contains("lean4-message-information")).toBe(true);
    expect(card.querySelector(".lean4-message-kind")?.textContent).toBe("信息");
    expect(card.querySelector(".lean4-message-position")?.textContent).toBe("行 1 · 列 1");
    expect(card.querySelector("pre.lean4-message-body")?.textContent).toBe(message);
    expect(card.querySelector("script")).toBeNull();
    expect(card.textContent).not.toContain("计算输出");
  });

  it("follows the English interface language without translating Lean text", () => {
    setLanguage("en");
    const message = "Nat : Type";
    const card = LeanMessagePresenter.render(document.body, {
      severity: "information", message,
      range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } }
    });
    expect(card.querySelector(".lean4-message-kind")?.textContent).toBe("Information");
    expect(card.querySelector(".lean4-message-position")?.textContent).toBe("Line 10 · Column 3");
    expect(card.querySelector(".lean4-message-body")?.textContent).toBe(message);
    const goal = LeanGoalPresenter.render(document.body, "n : Nat\n⊢ n = n", 1);
    expect(goal.getAttribute("aria-label")).toBe("Goal 2");
    expect(goal.querySelector(".lean4-goal-context .lean4-goal-section-label")?.textContent).toBe("Context");
    expect(goal.querySelector(".lean4-goal-target .lean4-goal-section-label")?.textContent).toBe("To prove");
  });

  it("navigates only from the location button, leaving the message body selectable", () => {
    const navigate = vi.fn();
    const card = LeanMessagePresenter.render(document.body, {
      severity: "warning", message: "declaration uses sorry",
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } }
    }, navigate);
    (card.querySelector(".lean4-message-body") as HTMLElement).click();
    expect(navigate).not.toHaveBeenCalled();
    const position = card.querySelector("button")!;
    expect(position.type).toBe("button");
    expect(position.getAttribute("aria-label")).toContain("行 3 · 列 4");
    position.click();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("preserves multiline context, case text and each complete goal while separating the first turnstile", () => {
    const first = "case induction.step\nn : Nat\nh : ∀ x,\n  x = x\n⊢ n + 0 = n\n  ∧ True";
    const second = "case remaining\n⊢ True";
    LeanGoalPresenter.render(document.body, first, 0);
    LeanGoalPresenter.render(document.body, second, 1);
    const goals = [...document.querySelectorAll(".lean4-goal")];
    expect(goals).toHaveLength(2);
    expect(goals[0]!.getAttribute("aria-label")).toBe("目标 1");
    expect(goals[0]!.querySelector(".lean4-goal-context .lean4-goal-code")?.textContent)
      .toBe("case induction.step\nn : Nat\nh : ∀ x,\n  x = x\n");
    expect(goals[0]!.querySelector(".lean4-goal-target .lean4-goal-code")?.textContent)
      .toBe("⊢ n + 0 = n\n  ∧ True");
    for (const [index, goal] of goals.entries()) {
      expect([...goal.querySelectorAll(".lean4-goal-code")].map(part => part.textContent).join(""))
        .toBe([first, second][index]);
    }
  });

  it("renders unrecognized goal text intact and safely instead of inventing a context", () => {
    const text = "unknown response\n<script>unsafe</script>\nnot a turnstile";
    const goal = LeanGoalPresenter.render(document.body, text, 0);
    expect(goal.querySelector(".lean4-goal-raw .lean4-goal-code")?.textContent).toBe(text);
    expect(goal.querySelector(".lean4-goal-context")).toBeNull();
    expect(goal.querySelector("script")).toBeNull();
  });

  it("uses native accessible icon buttons and prevents the host embed from consuming their clicks", () => {
    const parentClick = vi.fn();
    const action = vi.fn();
    document.body.addEventListener("click", parentClick, { once: true });
    const button = LeanIconButton.create(document.body, "play", "检查代码块");
    button.addEventListener("click", action);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("检查代码块");
    expect(button.title).toBe("检查代码块");
    expect(button.querySelector("svg")?.classList.contains("lucide-play")).toBe(true);
    button.disabled = true;
    button.click();
    expect(action).not.toHaveBeenCalled();
    button.disabled = false;
    button.click();
    expect(action).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    document.body.removeEventListener("click", parentClick);
  });
});
