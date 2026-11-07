import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  archivePath,
  copyPageLink,
  isShareCancellation,
  nativeShare,
  pageLink,
  projectDetailPath,
  projectsPath,
  settingsPath,
  taskKeyPath,
  tasksPath,
  teamFromSearch,
} from "./page-link.js";

const origin = "https://hearth.jharrison.io";

describe("page links", () => {
  test("tasks, archive, and settings keep the list and the filter", () => {
    assert.equal(tasksPath("11111111-1111-4111-8111-111111111111", "do_now"), "/tasks?team=11111111-1111-4111-8111-111111111111");
    assert.equal(
      tasksPath("11111111-1111-4111-8111-111111111111", "later"),
      "/tasks?team=11111111-1111-4111-8111-111111111111&action=later",
    );
    assert.equal(projectsPath(null), "/projects");
    assert.equal(
      projectDetailPath("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
      "/projects/22222222-2222-4222-8222-222222222222?team=11111111-1111-4111-8111-111111111111",
    );
    assert.equal(archivePath("11111111-1111-4111-8111-111111111111", "all"), "/archive?team=11111111-1111-4111-8111-111111111111");
    assert.equal(
      archivePath("11111111-1111-4111-8111-111111111111", "cancelled"),
      "/archive?team=11111111-1111-4111-8111-111111111111&status=cancelled",
    );
    assert.equal(settingsPath("11111111-1111-4111-8111-111111111111"), "/teams/11111111-1111-4111-8111-111111111111");
    assert.equal(settingsPath(null), "/settings");
    assert.equal(taskKeyPath("H-4"), "/t/H-4");
  });

  test("a page link is the absolute url of that path", () => {
    const link = pageLink(tasksPath("11111111-1111-4111-8111-111111111111", "delegate"), "Tasks", origin);
    assert.deepEqual(link, {
      title: "Tasks",
      url: "https://hearth.jharrison.io/tasks?team=11111111-1111-4111-8111-111111111111&action=delegate",
    });
    assert.equal(pageLink("/t/J-2", "Buy oat milk", "http://127.0.0.1:43123").url, "http://127.0.0.1:43123/t/J-2");
  });

  test("only a team uuid in the query selects a list", () => {
    assert.equal(teamFromSearch("?team=11111111-1111-4111-8111-111111111111&status=done"), "11111111-1111-4111-8111-111111111111");
    assert.equal(teamFromSearch("?team=Work%20Life"), null);
    assert.equal(teamFromSearch(""), null);
  });

  test("copy always writes the full url, and a clipboard failure is recoverable", async () => {
    const written: string[] = [];
    assert.equal(await copyPageLink("https://hearth.jharrison.io/t/H-4", async (value) => {
      written.push(value);
    }), "copied");
    assert.deepEqual(written, ["https://hearth.jharrison.io/t/H-4"]);
    assert.equal(
      await copyPageLink("https://hearth.jharrison.io/archive?status=done", async () => {
        throw new Error("denied");
      }),
      "failed",
    );
  });

  test("native share can succeed, cancel quietly, or fail", async () => {
    const link = pageLink("/projects", "Projects", origin);
    const shared: { title: string; url: string }[] = [];
    assert.equal(await nativeShare(link, async (data) => {
      shared.push(data);
    }), "shared");
    assert.deepEqual(shared, [{ title: "Projects", url: link.url }]);
    assert.equal(
      await nativeShare(link, async () => {
        throw new DOMException("User dismissed", "AbortError");
      }),
      "cancelled",
    );
    assert.equal(isShareCancellation(new DOMException("nope", "NotAllowedError")), false);
    assert.equal(
      await nativeShare(link, async () => {
        throw new DOMException("nope", "NotAllowedError");
      }),
      "failed",
    );
  });
});
