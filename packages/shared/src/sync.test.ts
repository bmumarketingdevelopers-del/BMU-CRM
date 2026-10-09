import { describe, expect, it } from "vitest";
import { mergeChecklist, mergeTask, OfflineError, pushCategory, SyncQueue, type QueuedOp, type SyncOpInput, type SyncOpResult, type TaskSnapshot } from "./index.js";

const server: TaskSnapshot = { status: "todo", blockedReason: null, title: "Edit reel", description: "First cut", checklist: [{ id: "a", label: "Rough cut", done: false }], priority: "normal" };

describe("three-way task merge", () => {
  it("applies fields nobody else touched", () => {
    const r = mergeTask(server, { status: "todo", title: "Edit reel" }, { status: "in_progress", title: "Edit reel v2" });
    expect(r.patch).toEqual({ status: "in_progress", title: "Edit reel v2" });
    expect(r.conflicts).toEqual([]);
  });

  it("finished elsewhere wins over an offline status change", () => {
    const r = mergeTask({ ...server, status: "done" }, { status: "todo" }, { status: "in_progress" });
    expect(r.patch).toEqual({});
    expect(r.conflicts[0]).toMatchObject({ field: "status", kept: "theirs" });
  });

  it("the person doing the work keeps their status otherwise", () => {
    const r = mergeTask({ ...server, status: "waiting" }, { status: "todo" }, { status: "done" });
    expect(r.patch.status).toBe("done");
    expect(r.conflicts[0].kept).toBe("yours");
  });

  it("text edited on both sides keeps the server's and reports it", () => {
    const r = mergeTask({ ...server, title: "Edit reel (client name)" }, { title: "Edit reel" }, { title: "Edit the reel" });
    expect(r.patch).toEqual({});
    expect(r.conflicts[0]).toMatchObject({ field: "title", yours: "Edit the reel", kept: "theirs" });
  });

  it("checklists merge item by item", () => {
    const base = [{ id: "a", label: "Rough cut", done: false }, { id: "b", label: "Music", done: false }];
    const there = [{ id: "a", label: "Rough cut", done: false }, { id: "b", label: "Music", done: true }, { id: "c", label: "Captions", done: false }];
    const here = [{ id: "a", label: "Rough cut", done: true }, { id: "b", label: "Music", done: false }, { id: "d", label: "Colour", done: false }];
    expect(mergeChecklist(there, base, here)).toEqual([
      { id: "a", label: "Rough cut", done: true },
      { id: "b", label: "Music", done: true },
      { id: "c", label: "Captions", done: false },
      { id: "d", label: "Colour", done: false },
    ]);
  });
});

describe("offline queue", () => {
  function memory() {
    let saved: QueuedOp[] = [];
    return { storage: { load: async () => saved, save: async (o: QueuedOp[]) => void (saved = JSON.parse(JSON.stringify(o))) }, saved: () => saved };
  }

  it("keeps changes while offline, combines them, and sends them once back online", async () => {
    let online = false;
    const sent: SyncOpInput[][] = [];
    const m = memory();
    const q = await new SyncQueue(m.storage, async (ops) => {
      if (!online) throw new OfflineError();
      sent.push(ops);
      return ops.map((o): SyncOpResult => ({ clientOpId: o.clientOpId, status: "applied", message: null, conflicts: [], task: null }));
    }).init();
    await q.enqueueTask("t1", { status: "todo" }, { status: "in_progress" });
    await q.enqueueTask("t1", { status: "in_progress" }, { status: "done", logMinutes: 30 });
    await q.enqueueTask("t1", {}, { logMinutes: 15 });
    expect(q.pending()).toBe(1);
    expect(await q.flush()).toEqual([]);
    expect(q.pending()).toBe(1);
    expect(m.saved()[0]).toMatchObject({ base: { status: "todo" }, changes: { status: "done", logMinutes: 45 }, tries: 1 });

    // The app restarts: the queue survives in storage.
    const q2 = await new SyncQueue(m.storage, async (ops) => {
      sent.push(ops);
      return ops.map((o): SyncOpResult => ({ clientOpId: o.clientOpId, status: "applied", message: null, conflicts: [], task: null }));
    }).init();
    online = true;
    const results = await q2.flush();
    expect(results).toHaveLength(1);
    expect(q2.pending()).toBe(0);
    expect(sent[0][0]).toMatchObject({ entityId: "t1", base: { status: "todo" }, changes: { status: "done", logMinutes: 45 } });
    expect("tries" in sent[0][0]).toBe(false);
  });

  it("push categories", () => {
    expect(pushCategory({ kind: "approval_needed", link: "/team/approvals", ref: "ap1" })).toEqual({ category: "approval", ref: "ap1" });
    expect(pushCategory({ kind: "message", link: "/team/messages/th1" })).toEqual({ category: "message", ref: "th1" });
    expect(pushCategory({ kind: "task_assigned", link: "/team/tasks/t9" })).toEqual({ category: "task", ref: "t9" });
    expect(pushCategory({ kind: "x", link: "/somewhere" }).category).toBe("general");
  });
});
