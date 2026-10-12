import type { Request } from "express";
import { staffOf } from "./auth.js";
import { csrfField } from "../security/csrf.js";

// Top navigation for signed-in staff: only the pages their role can open, plus log out.
export function nav(req: Request): string {
  const s = staffOf(req);
  const links: Array<[string, string, string[]]> = [
    ["/staff/inbox", "Inbox", ["admin", "nurse", "dada"]],
    ["/staff/label", "Label messages", ["admin", "nurse", "dada"]],
    ["/staff/clinic", "Check a pass", ["admin", "clinic"]],
    ["/staff/dashboard", "Dashboard", ["admin", "nurse", "partner"]],
    ["/staff/audit", "Audit log", ["admin"]],
    ["/staff/password", "Password", ["admin", "nurse", "dada", "clinic", "partner"]],
  ];
  return (
    links.filter(([, , roles]) => roles.includes(s.role)).map(([href, label]) => `<a href="${href}">${label}</a>`).join("") +
    `<form method="post" action="/staff/logout" style="display:inline">${csrfField(req)}<button class="secondary" style="min-height:36px;padding:0 16px">Log out</button></form>`
  );
}
