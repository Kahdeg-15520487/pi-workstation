import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSkill(name: string): string {
  return readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf-8");
}

function discoveredSkillNames(): string[] {
  const skillsDir = new URL("../skills/", import.meta.url);
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/SKILL.md`, skillsDir)))
    .map((entry) => entry.name)
    .sort();
}

describe("bundled skills", () => {
  it("keeps standalone discipline skills and drops goal/clarification skills", () => {
    const skills = discoveredSkillNames();

    expect(skills).toContain("agentic-brainstorming");
    expect(skills).toContain("agentic-karpathy");
    expect(skills).toContain("agentic-rob-pike");
    expect(skills).toContain("agentic-simplify");
    expect(skills).toContain("agentic-systematic-debugging");
    expect(skills).not.toContain("agentic-goal");
    expect(skills).not.toContain("agentic-clarification");
  });

  it("every remaining skill has no goal/clarify runtime coupling", () => {
    for (const name of discoveredSkillNames()) {
      const src = readSkill(name);
      expect(src).not.toContain("/goal");
      expect(src).not.toContain("clarification_state");
      expect(src).not.toContain("reviewer-verifier");
    }
  });

  it("karpathy skill documents behavioral guardrails", () => {
    const src = readSkill("agentic-karpathy");
    expect(src.toLowerCase()).toContain("surgical");
    expect(src.toLowerCase()).toContain("assumption");
  });

  it("rob-pike skill documents measurement-driven rules", () => {
    const src = readSkill("agentic-rob-pike");
    expect(src.toLowerCase()).toContain("measure");
  });

  it("systematic-debugging skill documents reproduce-first workflow", () => {
    const src = readSkill("agentic-systematic-debugging");
    expect(src.toLowerCase()).toContain("reproduce");
  });
});