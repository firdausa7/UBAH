import PDFDocument from "pdfkit";
import { showCount, showPct, sup, type DashboardStats } from "../stats.js";

// Monthly report for donors and partners, as a real PDF. Same numbers and the same
// privacy rule as the dashboard (counts of 1 to 4 shown as "<5").

const INK = "#151D2C";
const MUTED = "#5B6575";
const LINE = "#ECE8E3";

export function monthlyReportPdf(st: DashboardStats, meta: { title: string; period: string; scope: string; generatedBy: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: meta.title, Author: "Ubah", Subject: meta.period } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width - 100;

    doc.fillColor("#C8462B").font("Helvetica-Bold").fontSize(14).text("ubah");
    doc.moveDown(0.3).fillColor(INK).font("Helvetica").fontSize(22).text(meta.title);
    doc.fillColor(MUTED).fontSize(10).text(`${meta.period} · ${meta.scope}`);
    doc.text(`All figures are anonymous. Counts of 1 to 4 are shown as "<5" and percentages need at least 5 answers, so no girl can be identified.`, { width: W });
    doc.moveDown(1);

    const heading = (t: string) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(0.6).fillColor(INK).font("Helvetica-Bold").fontSize(13).text(t).font("Helvetica").moveDown(0.3);
    };
    const table = (headers: string[], rows: string[][], widths: number[]) => {
      const x0 = doc.page.margins.left;
      const row = (cells: string[], bold = false) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y;
        let x = x0;
        let h = 0;
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? MUTED : INK);
        cells.forEach((c, i) => {
          doc.text(c, x + 2, y + 4, { width: widths[i] - 4 });
          h = Math.max(h, doc.y - y);
          x += widths[i];
        });
        doc.y = y + h + 4;
        doc.moveTo(x0, doc.y).lineTo(x0 + W, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
      };
      row(headers, true);
      rows.forEach((r) => row(r));
      doc.x = x0;
    };

    heading("Key numbers");
    table(
      ["Measure", "Value"],
      [
        ["Girls who asked a question", showCount(st.girls)],
        ["Questions answered", showCount(st.questions)],
        ["Asked by voice note", showPct(st.voiceShare)],
        ["Referral passes issued", showCount(st.passes)],
        ["Day-3 check-in answers", showCount(st.checkinsAnswered)],
        ["Visits confirmed by girls", `${showCount(st.visitsConfirmed)} (${showPct(st.visitRate)})`],
        ["Urgent cases handed to a person", showCount(st.urgentCases)],
        ["Median first reply to urgent cases", st.medianUrgentReplyMin == null ? "—" : `${Math.round(st.medianUrgentReplyMin)} min`],
      ],
      [W * 0.65, W * 0.35],
    );

    heading("Questions per week");
    const maxQ = Math.max(1, ...st.weeks.map((w) => w.questions ?? 0));
    const chartH = 90;
    const top = doc.y;
    const barW = Math.min(36, (W - 10) / Math.max(1, st.weeks.length) - 4);
    st.weeks.forEach((w, i) => {
      const x = doc.page.margins.left + i * (barW + 4);
      const v = w.questions;
      if (v === null) {
        doc.rect(x, top + chartH - 6, barW, 6).dash(2, { space: 2 }).strokeColor(MUTED).stroke().undash();
      } else if (v > 0) {
        const h = (v / maxQ) * chartH;
        doc.roundedRect(x, top + chartH - h, barW, h, 2).fillColor(INK).fill();
      }
      doc.fillColor(MUTED).fontSize(7).text(w.week.slice(5), x - 2, top + chartH + 3, { width: barW + 4, align: "center" });
    });
    doc.y = top + chartH + 18;
    doc.x = doc.page.margins.left;
    table(
      ["Week starting", "Questions", "Passes", "Visits confirmed", "Urgent"],
      st.weeks.map((w) => [w.week, showCount(w.questions), showCount(w.passes), showCount(w.visits), showCount(w.urgent)]),
      [W * 0.28, W * 0.18, W * 0.18, W * 0.2, W * 0.16],
    );

    heading("Clinic dignity scores");
    doc.fillColor(MUTED).fontSize(9).text("From girls' anonymous day-3 check-ins: were you treated with respect?").moveDown(0.3);
    table(
      ["Clinic", "Passes", "Visits", "Yes", "Partly", "No"],
      st.clinics.map((c) => [`${c.name}${c.verified ? "" : " (not verified)"}`, showCount(c.passes), showCount(c.visits), showPct(c.respectYes), showPct(c.respectPartly), showPct(c.respectNo)]),
      [W * 0.4, W * 0.12, W * 0.12, W * 0.12, W * 0.12, W * 0.12],
    );

    heading("What girls asked about");
    table(
      ["Topic", "Questions", "Share"],
      st.topics.map((t) => [t.topic.replace(/_/g, " "), showCount(t.n), showPct(t.share)]),
      [W * 0.5, W * 0.25, W * 0.25],
    );

    heading("Languages");
    table(["Language", "Girls"], st.languages.map((l) => [l.language, showCount(l.n)]), [W * 0.5, W * 0.5]);

    doc.moveDown(1).fillColor(MUTED).fontSize(8).text(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by ${meta.generatedBy}. Escalations to nurses: ${showCount(st.escalated)}. Labelled messages for model training: ${showCount(sup(st.labelledMessages))}.`, { width: W });
    doc.end();
  });
}
