# Danger words

One file per language. Any match makes the message URGENT: it goes straight to a nurse or Dada.
Every message is checked against every list (girls mix languages), and the English list is also
checked against the English translation of the message.

How to edit (no code needed):

- One word or phrase per line, under the heading for its kind of danger:
  `[medical]`, `[safety]` or `[selfharm]`.
- Lines starting with `#` are notes and are ignored.
- Capitals, punctuation and accents don't matter.
- `*` stands for any letters inside a word: `*bakwa` matches `nimebakwa` and `alibakwa`.
  Use it carefully: `dhiig*` would also match ordinary words about blood.
- A phrase matches only when its words appear next to each other, in that order.
- Somali words also match their forms with an article (`dhiig` matches `dhiigga`).

Adding a word is always safe: the worst case is that a nurse reads a message that wasn't urgent.
Removing a word needs a reviewer's agreement. After a change, run `npm test`.

DRAFT: the Somali, Kiswahili and Afaan Oromoo lists are a starting point written without native
speakers. They must be checked and extended with nurses, Dadas and translators before the pilot.
