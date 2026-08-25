import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitApiController } from "./api";

const note: ContentType = {
  name: "Note",
  kind: "collection",
  fields: [
    { type: "string", name: "recordId", required: true, unique: true },
    { type: "text", name: "text" },
  ],
} as ContentType;

const columns = ["record_id", "text", "owner_id"];

describe("emitApiController", () => {
  it("emits unsecured CRUD with create()", () => {
    const php = emitApiController(note, columns, { secured: false });
    expect(php).toContain("namespace App\\Http\\Controllers\\Api;");
    expect(php).toContain("class NoteApiController extends Controller");
    expect(php).toContain("private const FIELDS = ['record_id', 'text', 'owner_id'];");
    expect(php).toContain("Note::query()->paginate(50)");
    expect(php).toContain("Note::create($payload)");
    expect(php).toContain("public function show(Note $note)");
    expect(php).not.toContain("authorize(");
  });

  it("upserts via updateOrCreate when upsertBy is set", () => {
    const upsertNote = {
      ...note,
      options: { upsertBy: "recordId" },
    } as ContentType;
    const php = emitApiController(upsertNote, columns, { secured: false });
    expect(php).toContain(
      "Note::updateOrCreate(['record_id' => $payload['record_id'] ?? null], $payload)",
    );
    expect(php).toContain("$note->wasRecentlyCreated ? 201 : 200");
  });

  it("secured variant authorizes every method against the policies", () => {
    const php = emitApiController(note, columns, { secured: true });
    expect(php).toContain("$this->authorize('viewAny', Note::class);");
    expect(php).toContain("$this->authorize('view', $note);");
    expect(php).toContain("$this->authorize('create', Note::class);");
    expect(php).toContain("$this->authorize('update', $note);");
    expect(php).toContain("$this->authorize('delete', $note);");
  });

  it("uses Laravel's singular snake wildcard for multi-word models", () => {
    const session: ContentType = {
      name: "ActivitySession",
      kind: "collection",
      fields: [{ type: "dateTime", name: "occurredAt" }],
    } as ContentType;
    const php = emitApiController(session, ["occurred_at"], { secured: false });
    expect(php).toContain("public function show(ActivitySession $activity_session)");
  });
});
