// @ts-check
// 回收站保留期清理：只删超期条目、认不出时间的保留、清单可读。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPurgeManifest,
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  deletedAtFromName,
  selectExpired,
} from "../lib/purge.js";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const name = (/** @type {number} */ daysAgo) =>
  `prj_x-${new Date(NOW - daysAgo * DAY_MS).toISOString().replace(/[:.]/gu, "-")}`;

describe("deletedAtFromName", () => {
  it("能从 trashDirFor 生成的目录名里取回时间", () => {
    const at = deletedAtFromName(name(10));
    assert.ok(typeof at === "number");
    assert.ok(Math.abs(Number(at) - (NOW - 10 * DAY_MS)) < 1000);
  });

  it("认不出就返回 null", () => {
    assert.equal(deletedAtFromName("junk"), null);
    assert.equal(deletedAtFromName(""), null);
  });
});

describe("selectExpired", () => {
  it("超过保留期的进入 eligible，未超期的保留", () => {
    const { eligible, kept } = selectExpired(
      [
        { name: name(40), path: "/t/old", bytes: 100 },
        { name: name(5), path: "/t/new", bytes: 10 },
      ],
      { nowMs: NOW, retentionDays: 30 },
    );
    assert.deepEqual(
      eligible.map((entry) => entry.path),
      ["/t/old"],
    );
    assert.equal(kept, 1);
  });

  it("认不出时间的条目一律保留（不猜着删）", () => {
    const { eligible, kept } = selectExpired([{ name: "junk", path: "/t/junk" }], {
      nowMs: NOW,
      retentionDays: 1,
    });
    assert.deepEqual(eligible, []);
    assert.equal(kept, 1);
  });

  it("保留期为 0 时所有可判定条目都超期", () => {
    const { eligible } = selectExpired([{ name: name(0), path: "/t/now" }], {
      nowMs: NOW,
      retentionDays: 0,
    });
    assert.equal(eligible.length, 1);
  });

  it("默认保留期是 30 天", () => {
    assert.equal(DEFAULT_RETENTION_DAYS, 30);
  });
});

describe("buildPurgeManifest", () => {
  it("清单写清时间/保留期/条目/体积，并声明不可恢复", () => {
    const text = buildPurgeManifest({
      purgedAt: "2026-11-21T00:00:00.000Z",
      retentionDays: 30,
      entries: [{ name: name(40), path: "/t/old", bytes: 100, ageDays: 40 }],
    });
    assert.match(text, /回收站清理清单/u);
    assert.match(text, /保留期：30 天/u);
    assert.match(text, /条目数：1/u);
    assert.match(text, /合计体积：100 字节/u);
    assert.match(text, /只能从你自己的备份恢复/u);
  });
});
