import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBrowserLang, isRtlLang, SUPPORTED_LANGS } from "../build/ts/i18n.js";

test("matchBrowserLang matches plain two-letter codes directly", () => {
  assert.equal(matchBrowserLang("fr"), "fr");
  assert.equal(matchBrowserLang("de"), "de");
  assert.equal(matchBrowserLang("ja"), "ja");
});

test("matchBrowserLang strips a region from a base-only-shipped language", () => {
  assert.equal(matchBrowserLang("fr-CA"), "fr");
  assert.equal(matchBrowserLang("de-AT"), "de");
  assert.equal(matchBrowserLang("ar-EG"), "ar");
});

test("matchBrowserLang routes English by region (GB/US exact, everything else generic)", () => {
  assert.equal(matchBrowserLang("en-GB"), "en_GB");
  assert.equal(matchBrowserLang("en-US"), "en_US");
  assert.equal(matchBrowserLang("en"), "en_US");
  assert.equal(matchBrowserLang("en-AU"), "en");
  assert.equal(matchBrowserLang("en-CA"), "en");
});

test("matchBrowserLang routes Spanish to es vs es_419 (Latin American convention)", () => {
  assert.equal(matchBrowserLang("es-ES"), "es");
  assert.equal(matchBrowserLang("es"), "es");
  assert.equal(matchBrowserLang("es-MX"), "es_419");
  assert.equal(matchBrowserLang("es-419"), "es_419");
  assert.equal(matchBrowserLang("es-AR"), "es_419");
});

test("matchBrowserLang routes Portuguese to pt_BR vs pt_PT", () => {
  assert.equal(matchBrowserLang("pt-BR"), "pt_BR");
  assert.equal(matchBrowserLang("pt-PT"), "pt_PT");
  assert.equal(matchBrowserLang("pt"), "pt_PT");
  assert.equal(matchBrowserLang("pt-AO"), "pt_PT");
});

test("matchBrowserLang routes Chinese to zh_CN vs zh_TW by region or script subtag", () => {
  assert.equal(matchBrowserLang("zh-CN"), "zh_CN");
  assert.equal(matchBrowserLang("zh-TW"), "zh_TW");
  assert.equal(matchBrowserLang("zh-HK"), "zh_TW");
  assert.equal(matchBrowserLang("zh-Hant-TW"), "zh_TW");
  assert.equal(matchBrowserLang("zh-Hans-CN"), "zh_CN");
  assert.equal(matchBrowserLang("zh"), "zh_CN");
});

test("matchBrowserLang folds Norwegian Bokmal/Nynorsk into the single shipped 'no'", () => {
  assert.equal(matchBrowserLang("nb"), "no");
  assert.equal(matchBrowserLang("nn"), "no");
  assert.equal(matchBrowserLang("nb-NO"), "no");
});

test("matchBrowserLang normalizes legacy ISO 639-1 codes browsers may still send", () => {
  assert.equal(matchBrowserLang("iw"), "he"); // old Hebrew code
  assert.equal(matchBrowserLang("in"), "id"); // old Indonesian code
  assert.equal(matchBrowserLang("tl"), "fil"); // Tagalog -> Filipino (the code this extension ships)
});

test("matchBrowserLang accepts an underscore separator the same as a hyphen", () => {
  assert.equal(matchBrowserLang("pt_BR"), "pt_BR");
  assert.equal(matchBrowserLang("zh_TW"), "zh_TW");
});

test("matchBrowserLang falls back to English for an unshipped language or empty input", () => {
  assert.equal(matchBrowserLang("xx"), "en");
  assert.equal(matchBrowserLang(""), "en");
  assert.equal(matchBrowserLang(undefined), "en");
  assert.equal(matchBrowserLang(null), "en");
});

test("matchBrowserLang is case-insensitive", () => {
  assert.equal(matchBrowserLang("FR"), "fr");
  assert.equal(matchBrowserLang("En-Gb"), "en_GB");
  assert.equal(matchBrowserLang("ZH-tw"), "zh_TW");
});

test("SUPPORTED_LANGS has exactly the 54 locales this round added, each matching itself", () => {
  assert.equal(SUPPORTED_LANGS.length, 54);
  for (const lang of SUPPORTED_LANGS) {
    // Every shipped code must resolve to itself when fed back in (with
    // underscore variants normalized to the hyphen form a real browser
    // would actually send) — EXCEPT the bare "en" code, which is a
    // deliberate exception: a region-less "en" is treated as "en_US" (a
    // sensible default), so plain "en" never round-trips to itself. "en"
    // is reached only via a *different* English-speaking region that
    // isn't GB or US (e.g. "en-AU"), which is what's tested below instead.
    if (lang === "en") continue;
    assert.equal(matchBrowserLang(lang.replace("_", "-")), lang, `matchBrowserLang(${lang}) should round-trip`);
  }
  assert.equal(matchBrowserLang("en-AU"), "en", "a non-GB/US English region should map to the generic 'en'");
});

test("isRtlLang is true only for Arabic, Persian and Hebrew", () => {
  const rtl = new Set(["ar", "fa", "he"]);
  for (const lang of SUPPORTED_LANGS) {
    assert.equal(isRtlLang(lang), rtl.has(lang), `isRtlLang(${lang}) should be ${rtl.has(lang)}`);
  }
});
