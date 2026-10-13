import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { LANGUAGES } from "../i18n.js";
import { dashboardStats, MIN_RESPONSES, showCount, showPct, statsCsv, type Count, type Filters, type WeekRow } from "../stats.js";
import { monthlyReportPdf } from "../reports/monthlyPdf.js";
import { hasDemoData } from "../demo.js";
import { csrfField } from "../security/csrf.js";
import { refreshCaches } from "../caches.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, select } from "./html.js";
import { nav } from "./nav.js";

// Partner dashboard: date range, site/clinic/language filters, weekly trends, CSV export and a
// printable monthly PDF. Aggregates only; small groups are hidden.

const DAY = 864e5;
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const posInt = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function parseFilters(q: Record<string, unknown>, now = new Date()): Filters & { preset: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let from: Date;
  let to = new Date(today.getTime() + DAY); // exclusive: end of today
  let preset = "";
  if (isDate(q.from) && isDate(q.to) && String(q.from) <= String(q.to)) {
    from = new Date(`${q.from}T00:00:00Z`);
    to = new Date(new Date(`${q.to}T00:00:00Z`).getTime() + DAY);
  } else if (/^\d{4}-\d{2}$/.test(String(q.month ?? ""))) {
    from = new Date(`${q.month}-01T00:00:00Z`);
    to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    preset = `month:${q.month}`;
  } else {
    const days = [7, 30, 90, 365].includes(Number(q.days)) ? Number(q.days) : 30;
    from = new Date(to.getTime() - days * DAY);
    preset = `days:${days}`;
  }
  // Never more than two years at once (keeps the weekly chart readable).
  if (to.getTime() - from.getTime() > 731 * DAY) from = new Date(to.getTime() - 731 * DAY);
  return {
    from,
    to,
    preset,
    siteId: posInt(q.site),
    clinicId: posInt(q.clinic),
    language: String(q.lang ?? "") in LANGUAGES ? String(q.lang) : null,
  };
}

// One small bar chart per measure (no shared or dual axes). Hidden weeks (1–4) show as a dashed stub.
export function weeklyChart(title: string, weeks: WeekRow[], key: keyof Omit<WeekRow, "week">): string {
  const W = 320;
  const H = 120;
  const pad = { l: 8, r: 8, t: 18, b: 22 };
  const vals = weeks.map((w) => w[key] as Count);
  const max = Math.max(MIN_RESPONSES, ...vals.map((v) => v ?? 0));
  const n = Math.max(1, weeks.length);
  const slot = (W - pad.l - pad.r) / n;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const ih = H - pad.t - pad.b;
  const bars = weeks
    .map((w, i) => {
      const v = vals[i];
      const x = pad.l + i * slot + (slot - bw) / 2;
      const tip = `<title>Week of ${w.week}: ${v === null ? "fewer than 5" : v}</title>`;
      // Hit area is the whole column, wider than the bar.
      const hit = `<rect x="${(pad.l + i * slot).toFixed(1)}" y="${pad.t}" width="${slot.toFixed(1)}" height="${ih}" fill="transparent">${tip}</rect>`;
      if (v === null) return `<rect x="${x.toFixed(1)}" y="${H - pad.b - 6}" width="${bw.toFixed(1)}" height="6" fill="none" stroke="var(--muted)" stroke-dasharray="2 2" rx="1"/>${hit}`;
      if (!v) return hit;
      const h = Math.max(2, (v / max) * ih);
      const y = H - pad.b - h;
      const r = Math.min(4, bw / 2, h);
      // Rounded data end at the top, square at the baseline.
      const d = `M${x.toFixed(1)},${(H - pad.b).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)}V${(H - pad.b).toFixed(1)}Z`;
      return `<path d="${d}" fill="var(--ink)"/>${hit}`;
    })
    .join("");
  const total = vals.reduce<number>((a, v) => a + (v ?? 0), 0);
  const first = weeks[0]?.week.slice(5) ?? "";
  const last = weeks.at(-1)?.week.slice(5) ?? "";
  return `<figure style="margin:0"><figcaption class="eyebrow" style="display:flex;justify-content:space-between"><span>${esc(title)}</span><span>max ${max}</span></figcaption>
<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)} per week, ${weeks.length} weeks, about ${total} in total">
<line x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t}" y2="${pad.t}" stroke="var(--line)"/><line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="var(--line2)"/>
${bars}<text x="${pad.l}" y="${H - 6}">${esc(first)}</text><text x="${W - pad.r}" y="${H - 6}" text-anchor="end">${esc(last)}</text></svg></figure>`;
}

export function dashboardRouter(db: Db): Router {
  const r = Router();
  const viewers = requireRole(db, ["admin", "nurse", "partner"]);

  const options = async () => ({
    sites: await db.query<{ id: number; name: string }>(`SELECT id, name FROM sites ORDER BY name`),
    clinics: await db.query<{ id: number; name: string }>(`SELECT id, name FROM clinics ORDER BY name`),
  });
  const scopeLabels = (f: Filters, o: Awaited<ReturnType<typeof options>>) => ({
    site: o.sites.find((s) => s.id === f.siteId)?.name ?? "All sites",
    clinic: o.clinics.find((c) => c.id === f.clinicId)?.name ?? "All clinics",
    language: f.language ? LANGUAGES[f.language] : "All languages",
  });
  const filterQuery = (req: Request) => {
    const keep = ["from", "to", "days", "month", "site", "clinic", "lang"];
    const p = new URLSearchParams();
    for (const k of keep) if (req.query[k]) p.set(k, String(req.query[k]));
    return p;
  };

  r.get("/dashboard", viewers, async (req, res) => {
    const s = staffOf(req);
    await refreshCaches(db); // keeps the DEMO DATA banner current
    const f = parseFilters(req.query);
    const [st, o] = await Promise.all([dashboardStats(db, f), options()]);
    const lastDay = ymd(new Date(f.to.getTime() - DAY));
    const qs = filterQuery(req);
    const withFilters = (patch: Record<string, string>) => {
      const p = new URLSearchParams(qs);
      for (const k of ["from", "to", "days", "month"]) p.delete(k);
      for (const [k, v] of Object.entries(patch)) p.set(k, v);
      return `?${p}`;
    };
    const thisMonth = ymd(new Date()).slice(0, 7);
    const prevMonth = (() => {
      const d = new Date();
      return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))).slice(0, 7);
    })();
    const notByClinic = st.clinicFiltered ? `<span class="muted"> (not split by clinic)</span>` : "";
    const tile = (label: string, value: string, note: string, strong = false) =>
      `<div class="card" ${strong ? 'style="border-color:var(--accent);background:var(--accent-soft)"' : ""}><div class="eyebrow">${label}</div><div class="stat">${value}</div><div class="muted">${note}</div></div>`;
    const clinicRows = st.clinics
      .map(
        (c) => `<tr><td><strong>${esc(c.name)}</strong><div class="muted">${esc(c.area)}${c.site ? ` · ${esc(c.site)}` : ""}${c.verified ? "" : " · not yet verified"}</div></td><td>${showCount(c.passes)}</td><td>${showCount(c.visits)}</td>
<td>${c.respectYes == null ? `<span class="muted">fewer than ${MIN_RESPONSES} answers</span>` : `${showPct(c.respectYes)} yes · ${showPct(c.respectPartly)} partly · ${showPct(c.respectNo)} no`}</td></tr>`,
      )
      .join("");
    const topicRows = st.topics
      .map(
        (t) => `<div style="margin:8px 0"><div class="row between"><span>${esc(t.topic.replace(/_/g, " "))}</span><span class="muted">${showCount(t.n)} · ${showPct(t.share)}</span></div><div class="bar"><span style="width:${t.share == null ? 0 : Math.round(t.share * 100)}%"></span></div></div>`,
      )
      .join("");
    const model = (task: string) => {
      const m = st.modelReports[task];
      if (!m) return "not trained";
      return `${showPct(m.accuracy)} accuracy on ${m.examples} examples (${Object.entries(m.sources).map(([k, v]) => `${v} ${k}`).join(", ")})`;
    };
    const weeksTable = `<details><summary>Show the weekly numbers as a table</summary><div class="scroll"><table><thead><tr><th>Week starting</th><th>Questions</th><th>Passes</th><th>Visits confirmed</th><th>Urgent cases</th></tr></thead>
<tbody>${st.weeks.map((w) => `<tr><td>${w.week}</td><td>${showCount(w.questions)}</td><td>${showCount(w.passes)}</td><td>${showCount(w.visits)}</td><td>${showCount(w.urgent)}</td></tr>`).join("")}</tbody></table></div></details>`;

    res.send(
      page(
        "Dashboard",
        `${h1("Partner", "dashboard", `${ymd(f.from)} to ${lastDay}`)}
<form method="get" action="/staff/dashboard" class="card noprint"><div class="row pills" style="margin-bottom:8px">
${[7, 30, 90, 365].map((d) => `<a class="btn ${f.preset === `days:${d}` ? "" : "secondary"}" href="${withFilters({ days: String(d) })}">${d === 365 ? "12 months" : `${d} days`}</a>`).join("")}
<a class="btn ${f.preset === `month:${thisMonth}` ? "" : "secondary"}" href="${withFilters({ month: thisMonth })}">This month</a><a class="btn ${f.preset === `month:${prevMonth}` ? "" : "secondary"}" href="${withFilters({ month: prevMonth })}">Last month</a></div>
<div class="fields"><div><label for="f-from">From</label><input id="f-from" name="from" type="date" value="${ymd(f.from)}"></div><div><label for="f-to">To</label><input id="f-to" name="to" type="date" value="${lastDay}"></div>
${select("Site", "site", o.sites.map((x) => [String(x.id), x.name]), f.siteId ?? "", { blank: "All sites" })}${select("Clinic", "clinic", o.clinics.map((x) => [String(x.id), x.name]), f.clinicId ?? "", { blank: "All clinics" })}
${select("Language", "lang", Object.entries(LANGUAGES), f.language ?? "", { blank: "All languages" })}</div>
<p class="row"><button>Apply</button><a class="btn secondary" href="/staff/dashboard">Reset</a><a class="btn secondary" href="/staff/dashboard.csv?${qs}">Download CSV</a><a class="btn secondary" href="/staff/reports/monthly.pdf?${new URLSearchParams({ ...Object.fromEntries(qs), month: f.preset.startsWith("month:") ? f.preset.slice(6) : prevMonth })}">Monthly PDF report</a></p></form>
<p class="lead">All figures are anonymous. Counts of 1 to 4 show as "&lt;5", and percentages and clinic scores need at least ${MIN_RESPONSES} answers.</p>
<div class="grid" style="margin-bottom:14px">
${tile("Questions answered", showCount(st.questions) + notByClinic, `${showCount(st.girls)} girls · ${showPct(st.voiceShare)} by voice note`)}
${tile("Referral passes", showCount(st.passes), `${showCount(st.redeemed)} recorded at a clinic desk`)}
${tile("Visits confirmed", showPct(st.visitRate), `${showCount(st.visitsConfirmed)} of ${showCount(st.checkinsAnswered)} check-in answers`, true)}
${tile("Urgent handoffs", showCount(st.urgentCases) + notByClinic, st.medianUrgentReplyMin == null ? "median reply shown from 5 replies" : `median first reply ${Math.round(st.medianUrgentReplyMin)} min · ${showCount(st.escalated)} escalated`)}
</div>
<div class="card"><div class="eyebrow">Trends</div><h2><em>Week</em> by week</h2><div class="cols">${weeklyChart("Questions", st.weeks, "questions")}${weeklyChart("Passes issued", st.weeks, "passes")}${weeklyChart("Visits confirmed", st.weeks, "visits")}${weeklyChart("Urgent cases", st.weeks, "urgent")}</div>${weeksTable}</div>
<div class="card"><div class="eyebrow">Closing the loop</div><h2><em>Clinic</em> dignity scores</h2><p class="muted">From girls' anonymous day-3 check-ins after each referral.</p><div class="scroll"><table>
<thead><tr><th>Clinic</th><th>Passes</th><th>Visits confirmed</th><th>Treated with respect</th></tr></thead><tbody>${clinicRows || `<tr><td colspan="4">No clinics match.</td></tr>`}</tbody></table></div></div>
<div class="grid"><div class="card"><div class="eyebrow">Unmet need</div><h2><em>What</em> girls ask about</h2>${topicRows || '<p class="muted">No questions in this period.</p>'}</div>
<div class="card"><div class="eyebrow">Reach</div><h2><em>Languages</em></h2>${st.languages.map((l) => `<p class="row between"><span>${esc(LANGUAGES[l.language] ?? l.language)}</span><span class="muted">${showCount(l.n)} girls</span></p>`).join("") || '<p class="muted">No girls in this period.</p>'}</div>
<div class="card"><div class="eyebrow">Machine learning</div><h2><em>Ubah's</em> own models</h2><p><strong>Danger-sign classifier:</strong> ${model("danger")}</p><p><strong>Topic classifier:</strong> ${model("topic")}</p>
<p class="muted">${st.labelledMessages} messages labelled · ${showCount(st.codedTermMessages)} used coded words · ${st.openCases} open cases${st.dadaPayoutsPendingKes ? ` · KES ${st.dadaPayoutsPendingKes} Dada pay not yet paid` : ""}</p></div></div>
${s.role === "admin" ? `<div class="card noprint"><h2>Admin</h2><form method="post" action="/staff/admin/run-checkins">${csrfField(req)}<button class="secondary">Send due check-ins now</button></form>${req.query.sent != null ? `<p class="muted" role="status">${Number(req.query.sent)} check-in(s) sent.</p>` : ""}</div>` : ""}`,
        nav(req),
      ),
    );
  });

  r.get("/dashboard.csv", viewers, async (req, res) => {
    const f = parseFilters(req.query);
    const [st, o] = await Promise.all([dashboardStats(db, f), options()]);
    await auditReq(db, req, { action: "report.csv", details: { from: ymd(f.from), to: ymd(f.to), site: f.siteId, clinic: f.clinicId, lang: f.language } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ubah-${ymd(f.from)}-to-${ymd(new Date(f.to.getTime() - DAY))}.csv"`);
    res.send("﻿" + statsCsv(st, scopeLabels(f, o)));
  });

  r.get("/reports/monthly.pdf", viewers, async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? String(req.query.month) : ymd(new Date()).slice(0, 7);
    const f = parseFilters({ ...req.query, from: undefined, to: undefined, days: undefined, month });
    const [st, o] = await Promise.all([dashboardStats(db, f), options()]);
    const labels = scopeLabels(f, o);
    const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const pdf = await monthlyReportPdf(st, {
      title: (await hasDemoData(db)) ? "[DEMO DATA] Ubah monthly report" : "Ubah monthly report",
      period: monthName,
      scope: [labels.site, labels.clinic, labels.language].join(" · "),
      generatedBy: staffOf(req).name,
    });
    await auditReq(db, req, { action: "report.pdf", details: { month, site: f.siteId, clinic: f.clinicId, lang: f.language } });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ubah-report-${month}.pdf"`);
    res.send(pdf);
  });

  return r;
}
