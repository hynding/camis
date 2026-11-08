import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { schedulesBundle } from "../__fixtures__/schedules";

describe("filament schedules", () => {
  const result = filamentAdapter.generate(schedulesBundle, { projectName: "blog" });
  const file = (p: string) => result.files.find((f) => f.path === p);

  it("registers each with Laravel's scheduler", async () => {
    await expect(file("routes/schedule.php")!.content).toMatchFileSnapshot(
      "./__golden__/schedule.php",
    );
  });

  it("seeds each task against a generated contract", async () => {
    expect(file("app/Hooks/SendDigest.php")!.mode).toBe("seed");
    await expect(file("app/Hooks/SendDigest.php")!.content).toMatchFileSnapshot(
      "./__golden__/SendDigest.stub.php",
    );
    await expect(file("app/Hooks/Contracts/SendDigestTask.php")!.content).toMatchFileSnapshot(
      "./__golden__/SendDigestTask.php",
    );
  });

  it("says in DEPLOY.md that they run only where cron calls the scheduler", () => {
    const deploy = file("DEPLOY.md")!.content;
    expect(deploy).toContain("## Scheduled tasks");
    expect(deploy).toContain("* * * * * cd /path/to/app && php artisan schedule:run");
  });

  it("emits nothing for a project without them", () => {
    const plain = filamentAdapter.generate(
      { ...schedulesBundle, document: { ...schedulesBundle.document, schedules: [] } },
      { projectName: "blog" },
    );
    expect(plain.files.some((f) => f.path === "routes/schedule.php")).toBe(false);
    expect(plain.files.find((f) => f.path === "DEPLOY.md")!.content).not.toContain(
      "## Scheduled tasks",
    );
  });
});
