// @ts-check
// 数据根下的「追加」与「整份替换」：这两件事必须原子、且同一文件的写入必须串行。
// 审计 AUD-ADV-01 / AUD-ADV-02 的根因就是「读全文 + writeFile 覆盖」既非原子也不是单写者。
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { appendJsonLine, serializeByPath, writeTextAtomic } from "../lib/fs-atomic.js";

import { cleanupTempDirs, tempDir } from "./temp.js";

after(cleanupTempDirs);

/** @param {string} path */
const lines = async (path) =>
  (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");

describe("appendJsonLine", () => {
  it("逐行追加，不重写已写入的内容", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "a.jsonl");
    await appendJsonLine(path, { n: 1 });
    await appendJsonLine(path, { n: 2 });
    const raw = await readFile(path, "utf8");
    assert.deepEqual(
      raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).n),
      [1, 2],
    );
    assert.ok(raw.endsWith("\n"), "每行以换行结尾，方便 jq 与后续追加");
  });

  it("并发追加不丢行（O_APPEND 单写 + 进程内串行）", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "b.jsonl");
    await Promise.all(
      Array.from({ length: 24 }, (_item, index) => appendJsonLine(path, { n: index })),
    );
    assert.equal((await lines(path)).length, 24);
  });

  it("超过阈值时滚动到给定文件，新文件只留新行", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "c.jsonl");
    await writeFile(path, `${"x".repeat(4096)}\n`, "utf8");
    await appendJsonLine(path, { n: 1 }, { rotateBytes: 1024, rotateTo: `${path}.1` });
    assert.equal((await readFile(`${path}.1`, "utf8")).length, 4097);
    const fresh = await lines(path);
    assert.deepEqual(
      fresh.map((line) => JSON.parse(line).n),
      [1],
    );
  });
});

describe("writeTextAtomic", () => {
  it("替换整份内容且不留下临时文件", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "d.json");
    await writeTextAtomic(path, "one\n");
    await writeTextAtomic(path, "two\n");
    assert.equal(await readFile(path, "utf8"), "two\n");
    assert.deepEqual(await readdir(home), ["d.json"]);
  });

  it("并发整份替换不会互相踩（唯一 tmp 名）", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "e.json");
    await Promise.all(
      Array.from({ length: 16 }, (_item, index) => writeTextAtomic(path, `value-${index}\n`)),
    );
    assert.match(await readFile(path, "utf8"), /^value-\d+\n$/u);
    assert.deepEqual(await readdir(home), ["e.json"]);
  });
});

describe("serializeByPath", () => {
  it("同一路径的任务按提交顺序串行执行", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "f.jsonl");
    /** @type {number[]} */
    const order = [];
    await Promise.all(
      [5, 1, 3].map((delay, index) =>
        serializeByPath(path, async () => {
          order.push(index);
          await new Promise((resolve) => setTimeout(resolve, delay));
          order.push(index + 10);
        }),
      ),
    );
    assert.deepEqual(order, [0, 10, 1, 11, 2, 12]);
  });

  it("前一个任务失败不阻塞后面的任务，且失败会传回调用方", async () => {
    const home = await tempDir("advisor-atomic");
    const path = join(home, "g.jsonl");
    const failed = serializeByPath(path, async () => {
      throw new Error("boom");
    });
    await assert.rejects(failed, /boom/u);
    assert.equal(await serializeByPath(path, async () => "ok"), "ok");
  });
});
