import { describe, it, expect } from "vitest";
import { ALL_LANGUAGES, girlLanguages, languageConfig, resolveLanguage, validateConfigs, workerLabel, type LanguageConfig } from "../src/languages/index.js";
import { findDangerWords, loadDangerLists, parseDangerList, worstDanger } from "../src/ml/dangerWords.js";
import { analyse } from "../src/ml/models.js";
import { LANGUAGES, TRANSLATION_LANGUAGES } from "../src/i18n.js";

describe("language configs", () => {
  it("has a valid config for Somali, Kiswahili, Afaan Oromoo and English", () => {
    expect(ALL_LANGUAGES.map((l) => l.code)).toEqual(["so", "sw", "en", "om"]);
    expect(validateConfigs()).toEqual([]);
  });

  it("follows the rollout: Somali, Kiswahili and English enabled, Oromo in beta", () => {
    expect(languageConfig("so")?.status).toBe("enabled");
    expect(languageConfig("sw")?.status).toBe("enabled");
    expect(languageConfig("en")?.status).toBe("enabled");
    expect(languageConfig("om")?.status).toBe("beta");
  });

  it("gives English no translation step, and every other language one", () => {
    expect(languageConfig("en")?.translation).toBeNull();
    expect([...TRANSLATION_LANGUAGES].sort()).toEqual(["om", "so", "sw"]);
  });

  it("loads a danger-word list for every language", () => {
    const lists = loadDangerLists();
    for (const l of ALL_LANGUAGES) expect(lists[l.code].length, l.code).toBeGreaterThan(0);
  });

  it("reports broken configs", () => {
    const bad: LanguageConfig = { ...languageConfig("so")!, status: "maybe" as any, name: " ", translation: null };
    expect(validateConfigs([bad, bad])).toEqual(
      expect.arrayContaining(["so: listed twice", "so: unknown status maybe", "so: no display name", "so: no translation set", "en: the fallback language is missing"]),
    );
  });
});

describe("language fallback and visibility", () => {
  it("falls back to English for unknown or missing languages", () => {
    expect(resolveLanguage("so")).toBe("so");
    expect(resolveLanguage("om")).toBe("om");
    expect(resolveLanguage("fr")).toBe("en");
    expect(resolveLanguage(null)).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
  });

  it("shows girls a beta language without a label, and workers with one", () => {
    expect(LANGUAGES.om).toBe("Afaan Oromoo");
    expect(workerLabel("om")).toBe("Afaan Oromoo (Beta)");
    expect(workerLabel("so")).toBe("Soomaali");
  });

  it("never offers a disabled language", () => {
    const so = languageConfig("so")!;
    const before = so.status;
    try {
      so.status = "disabled";
      expect(girlLanguages().map((l) => l.code)).not.toContain("so");
      expect(resolveLanguage("so")).toBe("en");
    } finally {
      so.status = before;
    }
  });
});

describe("danger-word lists", () => {
  it("parses headings, notes and wildcards", () => {
    const list = parseDangerList("# note\n[medical]\ndamu nyingi\n\n[selfharm]\n*jiua\n", "sw");
    expect(list.map((p) => [p.label, p.phrase])).toEqual([
      ["medical", "damu nyingi"],
      ["selfharm", "*jiua"],
    ]);
  });

  it("refuses a list it can't read safely", () => {
    expect(() => parseDangerList("damu nyingi\n", "sw")).toThrow(/above the first \[heading\]/);
    expect(() => parseDangerList("[urgent]\ndamu\n", "sw")).toThrow(/unknown heading/);
  });

  // Sample sentences per language: [sentence, expected label or "none"].
  // DRAFT examples; native speakers should replace them with real phrasings.
  const samples: Record<string, Array<[string, string]>> = {
    so: [
      ["Dhiig badan ayaa iga imanaya, maxaan sameeyaa?", "medical"],
      ["Dhiigga badan ee iga yimid", "medical"],
      ["Waan suuxday shalay", "medical"],
      ["Waxaa la i kufsaday", "safety"],
      ["Aabahay wuu i garaacay", "safety"],
      ["Waxaan doonayaa inaan is dilo", "selfharm"],
      ["Caadadaydu way soo daahday", "none"],
      ["Dhiig yar ayaan arkay", "none"],
      ["Sidee looga hortagaa uurka?", "none"],
    ],
    sw: [
      ["Natoka damu nyingi sana", "medical"],
      ["Nilizimia shuleni leo", "medical"],
      ["Nimebakwa na jirani", "safety"],
      ["Baba ananipiga kila siku", "safety"],
      ["Wanataka kunikeketa mwezi ujao", "safety"],
      ["Nataka kujiua", "selfharm"],
      ["Sitaki kuishi tena", "selfharm"],
      ["Hedhi yangu imechelewa", "none"],
      ["Nataka kujua kuhusu uzazi wa mpango", "none"],
    ],
    om: [
      ["Dhiigni baay'ee na irraa dhufa", "medical"],
      ["Inni na rukuta", "safety"],
      ["Of ajjeesuu barbaada", "selfharm"],
      ["Laguun koo ture", "none"],
      ["Maaliif garaan na dhukkuba?", "none"],
    ],
    en: [
      ["I have heavy bleeding", "medical"],
      ["He raped me", "safety"],
      ["I want to die", "selfharm"],
      ["My period is late", "none"],
      ["How do I use a pad?", "none"],
    ],
  };

  for (const [lang, cases] of Object.entries(samples)) {
    for (const [sentence, expected] of cases) {
      it(`${lang}: "${sentence}" -> ${expected}`, () => {
        expect(worstDanger(findDangerWords(sentence))?.label ?? "none").toBe(expected);
      });
    }
  }

  it("catches danger words in a note that mixes languages", () => {
    const m = findDangerWords("Please help, dhiig badan and nataka kujiua");
    expect(m.map((x) => [x.language, x.label])).toEqual(expect.arrayContaining([["so", "medical"], ["sw", "selfharm"]]));
    expect(worstDanger(m)?.label).toBe("selfharm");
  });

  it("makes a Somali danger message urgent in the full analysis, whatever language she chose", () => {
    for (const chosen of ["so", "en", "sw"]) {
      const a = analyse("Dhiig badan ayaa iga imanaya", chosen);
      expect(a.danger).toBe("medical");
      expect(a.dangerSource).toBe("list");
      expect(a.dangerWord).toMatchObject({ language: "so", phrase: "dhiig badan" });
    }
  });
});

describe("the numbered language menu on SMS, WhatsApp and USSD", () => {
  it("follows the configs: a disabled language disappears and the rest are renumbered", async () => {
    const { freshDb, girl } = await import("./helpers.js");
    const { languageMenuText, t } = await import("../src/i18n.js");
    expect(languageMenuText()).toBe("1 Soomaali\n2 Kiswahili\n3 English\n4 Afaan Oromoo");
    const db = await freshDb();
    const sw = languageConfig("sw")!;
    try {
      sw.status = "disabled";
      expect(t("en", "ussd_language")).toBe("Ubah\n1 Soomaali\n2 English\n3 Afaan Oromoo");
      const g = girl(db, "0712777001");
      const welcome = await g.send("hi");
      expect(welcome).toContain("1 Soomaali\n2 English\n3 Afaan Oromoo");
      expect(welcome).not.toContain("Kiswahili");
      await g.send("2");
      const [u] = await db.query(`SELECT language FROM users ORDER BY id DESC LIMIT 1`);
      expect(u.language).toBe("en"); // "2" now means English
    } finally {
      sw.status = "enabled";
    }
  });
});
