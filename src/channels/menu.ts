// Ubah's menus are written once, as numbered lines inside the (translated) message text:
//   "Reply:\n1 Find a clinic\n2 Talk to a Dada\n3 Ask another question"
// SMS shows them as they are. WhatsApp turns the numbered lines into buttons or a list, using the
// same translated words, and a tap sends back the number, so the engine sees "1" from every channel.

export interface MenuOption {
  id: string; // the number she would type
  title: string;
}

export interface ParsedMenu {
  body: string; // the message without the numbered lines (and without a lone "Reply:" line)
  options: MenuOption[];
}

const LINE = /^\s*(\d{1,2})\s*[).:-]?\s+(.+?)\s*$/;

export function parseMenu(text: string): ParsedMenu {
  const lines = text.split("\n");
  const options: MenuOption[] = [];
  const rest: string[] = [];
  // Only a block of numbered lines at the end of the message is a menu.
  let i = lines.length - 1;
  while (i >= 0 && LINE.test(lines[i])) i--;
  const tail = lines.slice(i + 1);
  if (tail.length >= 2) {
    for (const l of tail) {
      const m = l.match(LINE)!;
      options.push({ id: m[1], title: m[2] });
    }
    rest.push(...lines.slice(0, i + 1));
  } else rest.push(...lines);
  // Drop a short prompt line ending in ":" ("Reply:") right above the menu; the buttons replace it.
  if (options.length && rest.length > 1 && /:\s*$/.test(rest[rest.length - 1]) && rest[rest.length - 1].trim().length <= 40) rest.pop();
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) return { body: text, options: [] }; // repeated numbers: not a menu
  return { body: rest.join("\n").trim() || text.trim(), options };
}

// WhatsApp limits: reply buttons max 3, title 20 chars; list max 10 rows, title 24 chars.
export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
