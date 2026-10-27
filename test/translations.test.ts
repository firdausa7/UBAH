import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "./helpers.js";
import { parseCsv, toCsv } from "../src/tools/csv.js";
import { exportStrings, exportTemplates, importStrings, importTemplates } from "../src/translations/csv.js";
import { chooseTranslation } from "../src/replies.js";
import { evaluateLanguage, meaningCoverage, readExpected, reportMarkdown } from "../src/eval/languages.js";
import type { Db } from "../src/db.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});

describe("CSV for spreadsheets", () => {
  it("round-trips quotes, commas, line breaks and Somali apostrophes, with a BOM for Excel", () => {
    const rows = [{ a: 'Ka warran, "saaxiib"?', b: "line one\nline two" }, { a: "ba'an", b: "" }];
    const csv = toCsv(rows, ["a", "b"]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv)).toEqual(rows);
  });
});

describe("UI strings: export for a native speaker, import for review", () => {
  it("exports only what isn't published yet, with drafts marked unchecked", async () => {
    await db.query(`INSERT INTO string_versions (key, language, version, text, status) VALUES ('web_send','so',1,'Dir','published'), ('web_back','so',1,'Dib','draft')`);
    const rows = parseCsv(await exportStrings(db, "so"));
    expect(rows.find((r) => r.key === "web_send")).toBeUndefined();
    expect(rows.find((r) => r.key === "web_back")).toMatchObject({ english: "Back", translation: "Dib", status: "draft (not checked)" });
    expect(rows.find((r) => r.key === "pass_issued")?.note).toMatch(/\{code\}/);
    expect(rows.find((r) => r.key === "web_record")?.status).toBe("missing");
  });

  it("imports checked lines as 'in review' for a reviewer, and refuses unchecked or broken ones", async () => {
    const csv = toCsv(
      [
        { key: "web_back", translation: "Dib u noqo", checked_by: "Hodan (translator)" },
        { key: "web_record", translation: "Taabo si aad u hadasho", checked_by: "" },
        { key: "pass_issued", translation: "Kaarkaaga: {code}", checked_by: "Hodan" },
        { key: "nope", translation: "x", checked_by: "Hodan" },
        { key: "web_send", translation: "", checked_by: "" },
      ],
      ["key", "translation", "checked_by"],
    );
    const r = await importStrings(db, "so", csv);
    expect(r.saved).toBe(1);
    expect(r.problems.join("\n")).toMatch(/web_record.*checked_by is empty/);
    expect(r.problems.join("\n")).toMatch(/pass_issued.*keep exactly/);
    expect(r.problems.join("\n")).toMatch(/unknown key nope/);
    const versions = await db.query(`SELECT text, status, review_note FROM string_versions WHERE key = 'web_back' AND language = 'so' ORDER BY version`);
    expect(versions).toEqual([
      { text: "Dib", status: "archived", review_note: "" },
      { text: "Dib u noqo", status: "in_review", review_note: "Checked by Hodan (translator) (CSV import)" },
    ]);
    // Never published by the import itself.
    expect((await db.query(`SELECT 1 FROM string_versions WHERE key = 'web_back' AND status = 'published'`)).length).toBe(0);
    // Importing the same file again changes nothing.
    expect((await importStrings(db, "so", csv)).saved).toBe(0);
  });
});

describe("answer templates: export and import", () => {
  it("uses a template once a named native speaker has checked it", async () => {
    const [t] = await db.query(`INSERT INTO answer_templates (language, english_text) VALUES ('sw','Please come to the clinic today.') RETURNING id`);
    const exported = parseCsv(await exportTemplates(db, "sw"));
    expect(exported).toEqual([{ id: String(t.id), english: "Please come to the clinic today.", translation: "", checked_by: "" }]);

    const unnamed = toCsv([{ id: String(t.id), translation: "Tafadhali njoo kliniki leo.", checked_by: "" }], ["id", "translation", "checked_by"]);
    expect((await importTemplates(db, "sw", unnamed)).problems[0]).toMatch(/not used until checked_by/);
    expect(await chooseTranslation(db, "sw", "Please come to the clinic today.")).toMatchObject({ source: "machine" });

    const named = toCsv([{ id: String(t.id), translation: "Tafadhali njoo kliniki leo.", checked_by: "Amina" }], ["id", "translation", "checked_by"]);
    expect((await importTemplates(db, "sw", named)).saved).toBe(1);
    expect(await chooseTranslation(db, "sw", "Please come to the clinic today.")).toEqual({ ok: true, text: "Tafadhali njoo kliniki leo.", source: "template" });
    expect(parseCsv(await exportTemplates(db, "sw"))).toEqual([]);
  });
});

describe("language evaluation harness", () => {
  const csv = toCsv(
    [
      { file: "001.ogg", said: "Caadadaydu way soo daahday", meaning: "My period is late", should_be_urgent: "no", consent_ref: "F-1" },
      { file: "002.ogg", said: "Dhiig badan ayaa iga imanaya", meaning: "I am bleeding a lot", should_be_urgent: "yes", consent_ref: "F-2" },
      { file: "003.ogg", said: "Waxaan rabaa inaan naftayda ka takhaluso", meaning: "I want to end my life", should_be_urgent: "yes", consent_ref: "F-3" },
      { file: "004.ogg", said: "No consent recorded", meaning: "x", should_be_urgent: "no", consent_ref: "" },
    ],
    ["file", "said", "meaning", "should_be_urgent", "consent_ref"],
  );

  it("refuses rows without a consent reference", () => {
    const r = readExpected(csv);
    expect(r.rows).toHaveLength(3);
    expect(r.refused).toBe(1);
    expect(readExpected("file,said,should_be_urgent,consent_ref\n1.ogg,hi,maybe,F\n").problems[0]).toMatch(/yes or no/);
  });

  it("runs transcription, translation and the danger check, and reports what was missed", async () => {
    const r = await evaluateLanguage("so", csv, "/nonexistent", { mock: true });
    expect(r.urgency).toEqual({ caught: 1, missed: 1, falseAlarms: 0, correctNone: 1 });
    expect(r.wer).toBe(0); // mock hears perfectly
    const md = reportMarkdown([r], { at: "2026-10-27", mock: true, stt: "mock", translation: "mock" });
    expect(md).toMatch(/MOCK RUN/);
    expect(md).toMatch(/### Urgent messages missed[\s\S]*003\.ogg/);
    expect(md).toMatch(/\| so \| 3 \|/);
  });

  it("says when a recording is missing (real run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubah-eval-"));
    writeFileSync(join(dir, "001.ogg"), "fake");
    const r = await evaluateLanguage("so", csv, dir);
    expect(r.items.find((i) => i.file === "002.ogg")?.error).toBe("audio file not found");
    expect(r.items.find((i) => i.file === "001.ogg")?.heardOk).toBe(false); // no speech key: nothing heard
  });

  it("estimates how much of the meaning the translation carries", () => {
    expect(meaningCoverage("My period is very late", "My period is late")).toBe(1);
    expect(meaningCoverage("I have a headache", "My period is late")).toBe(0);
    expect(meaningCoverage("anything", "")).toBeNull();
  });
});
