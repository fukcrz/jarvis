import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS, decideBundledSkillSync, decideRetiredSkill, hashSkillTree, reconcileBundledSkills, skillContentHash } from "./skill-reconcile.js";
import { bundledSkillRoot } from "./skill-service.js";

describe("bundled skill sync", () => {
  it("writes a missing tree, skips the current hash, updates an old hash, and keeps a local edit", () => {
    expect(decideBundledSkillSync(undefined, "now", ["old", "now"])).toBe("write");
    expect(decideBundledSkillSync("now", "now", ["old", "now"])).toBe("skip");
    expect(decideBundledSkillSync("old", "now", ["old", "now"])).toBe("write");
    expect(decideBundledSkillSync("edited", "now", ["old", "now"])).toBe("modified");
    expect(decideRetiredSkill(undefined, ["old"])).toBe("keep");
    expect(decideRetiredSkill("old", ["old", "now"])).toBe("delete");
    expect(decideRetiredSkill("edited", ["old", "now"])).toBe("keep");
  });

  it("ignores carriage returns when comparing skill content", () => {
    expect(skillContentHash("a\r\nb\n")).toBe(skillContentHash("a\nb\n"));
  });

  it("ships the current bundled tree hash in the manifest", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "skills", "manifest.json"), "utf8")) as { skills: Record<string, string[]> };
    for (const skill of BUNDLED_SKILLS) {
      const hash = await hashSkillTree(join(bundledSkillRoot(), skill.id));
      expect(manifest.skills[skill.id]).toContain(hash);
    }
  });

  it("does not overwrite a modified copy, and keeps the copy when disabling it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-skills-"));
    const skillsDir = join(root, "skills");
    const holdDir = join(root, "hold");
    const bundledDir = bundledSkillRoot();
    const known = Object.fromEntries(await Promise.all(BUNDLED_SKILLS.map(async (skill) => [skill.id, [await hashSkillTree(join(bundledDir, skill.id)) ?? ""]])));
    await reconcileBundledSkills({ skillsDir, bundledDir, holdDir, knownHashes: known, disabled: new Set() });
    const target = join(skillsDir, "browser-qa", "SKILL.md");
    await writeFile(target, "---\nname: browser-qa\ndescription: edited\n---\n\n# edited\n", "utf8");
    const kept = await reconcileBundledSkills({ skillsDir, bundledDir, holdDir, knownHashes: known, disabled: new Set() });
    expect(kept.find((item) => item.id === "browser-qa")?.modified).toBe(true);
    expect(await readFile(target, "utf8")).toContain("edited");
    const disabled = await reconcileBundledSkills({ skillsDir, bundledDir, holdDir, knownHashes: known, disabled: new Set(["browser-qa"]) });
    expect(disabled.find((item) => item.id === "browser-qa")).toMatchObject({ enabled: false, modified: true });
    expect(await readFile(join(holdDir, "browser-qa", "SKILL.md"), "utf8")).toContain("edited");
    const restored = await reconcileBundledSkills({ skillsDir, bundledDir, holdDir, knownHashes: known, disabled: new Set() });
    expect(restored.find((item) => item.id === "browser-qa")?.modified).toBe(true);
    expect(await readFile(target, "utf8")).toContain("edited");
  });

  it("removes an unmodified retired copy and keeps a local edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-retired-skills-"));
    const skillsDir = join(root, "skills");
    const holdDir = join(root, "hold");
    await mkdir(join(skillsDir, "old-skill"), { recursive: true });
    await mkdir(join(skillsDir, "edited-skill"), { recursive: true });
    await mkdir(join(holdDir, "old-skill"), { recursive: true });
    await writeFile(join(skillsDir, "old-skill", "SKILL.md"), "---\nname: old-skill\ndescription: shipped\n---\n\n# shipped\n", "utf8");
    await writeFile(join(skillsDir, "edited-skill", "SKILL.md"), "---\nname: edited-skill\ndescription: edited\n---\n\n# edited\n", "utf8");
    await writeFile(join(holdDir, "old-skill", "SKILL.md"), "---\nname: old-skill\ndescription: held\n---\n\n# held\n", "utf8");
    const shipped = await hashSkillTree(join(skillsDir, "old-skill"));
    await reconcileBundledSkills({
      skillsDir,
      bundledDir: bundledSkillRoot(),
      holdDir,
      knownHashes: {},
      retiredHashes: { "old-skill": [shipped ?? ""], "edited-skill": ["not-this-hash"], "../escape": [shipped ?? ""] },
      disabled: new Set(),
    });
    await expect(access(join(skillsDir, "old-skill"))).rejects.toThrow();
    expect(await readFile(join(skillsDir, "edited-skill", "SKILL.md"), "utf8")).toContain("edited");
    expect(await readFile(join(holdDir, "old-skill", "SKILL.md"), "utf8")).toContain("held");
  });
});
