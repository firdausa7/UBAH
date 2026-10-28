# Data Protection Impact Assessment — Ubah pilot

> **DRAFT TEMPLATE.** Prepared from how the Ubah software works, to be completed and signed by HPI-SOLUTIONS KE LIMITED with its health and protection partners and legal adviser. Everything in [square brackets] must be filled in. Statements about the law are a starting point only: confirm each with a qualified advocate and against the current Data Protection Act 2019, its Regulations (2021) and ODPC guidance.

| | |
|---|---|
| Data controller | HPI-SOLUTIONS KE LIMITED, [address], ODPC registration no. [number] |
| Data processors | [Hosting provider], Meta (WhatsApp Business Platform), Africa's Talking (SMS/USSD), [speech-to-text provider, if any], [AI model provider, if any], Safaricom (M-Pesa, staff payments only) |
| Data protection officer / contact | [name, email] |
| Assessment owner | [name, title] |
| Version / date | [v0.1, date] |
| Next review | [date — at least before scaling beyond the pilot, and whenever processing changes] |

## 1. Why a DPIA is needed
Ubah processes **health data** (sexual and reproductive health questions) and data about **violence and self-harm**, from **adolescent girls and young women in displacement and pastoralist settings**. Health data is sensitive personal data under the Act, and the people are vulnerable. Section 31 of the Act requires a DPIA where processing is likely to result in a high risk to rights and freedoms. [Confirm and cite.]

## 2. Description of the processing

| Data | Source | Purpose | Stored as | Kept for |
|---|---|---|---|---|
| Phone number (WhatsApp/SMS) | The channel | Recognise a returning girl; send replies and the day-3 check-in | Keyed hash (HMAC-SHA-256) + AES-256-GCM encrypted copy; never in clear | Until she sends DELETE, or [retention period] of inactivity |
| App device secret | The girls' app | Recognise the device | Keyed hash only | Until "Wipe my history" or [period] |
| Messages (text; transcripts of voice notes) | The girl | Answer her; send danger signs to a human; train safety models (labelled, anonymous) | Database, in text | [period] |
| Voice notes | The girl | Transcription; her assigned health worker listens when the transcript is unclear | Only if she consented to share her voice: AES-256-GCM encrypted in the database, reachable only through a 5-minute link made for her assigned worker; every play is in the access log. Otherwise not stored after transcription | Until the message is resolved, 30 days at most |
| Phone number + PIN (web) | The girl | Sign in on the website | Number hashed + encrypted as above; PIN hashed (scrypt); SMS login codes hashed, 10 minutes | Until DELETE; codes 1 day |
| Assignments and consents | Admin; the girl | Which health worker looks after her; what she shares with them | Database; consent history kept (latest choice counts) | [period] |
| English translations of her messages, and of replies | Translation provider | Her worker understands her; she understands the reply | Database, next to the original | [period] |
| Access log (which staff member looked at which girl's data) | System | Accountability | Append-only table; no message text | [period] |
| Age band (only if she chooses to say: under 15, 15–17, 18+, not said) | The girl | Child safeguarding: her worker is shown "Under 18" and follows the child-safeguarding procedure | Database; no date of birth | Until DELETE |
| Push address of her phone (only if she switches notifications on) | Her browser | Tell her phone "new message" | One URL per phone; the push carries no data, so the push service (Google, Apple, Mozilla) never receives message content | Until she switches it off, signs out or wipes her history |
| Language, area/site (if she shares it) | The girl | Language of replies; nearest clinic | Site and area name only; location coordinates are never stored | [period] |
| Referral passes, check-in answers (visited, respect) | The girl | Closing the loop; clinic dignity scores | Database; scores shown only from 5 answers | [period] |
| Case notes by Dadas and nurses | Staff | Care and safeguarding | Database; no names or numbers by rule | [period, per safeguarding policy] |
| Staff accounts (name, login, phone, role) | Admin | Access control, 2FA, payments | Database; passwords hashed (scrypt) | Employment + [period] |
| Audit log (who viewed/sent/changed what) | System | Accountability | Append-only table; no message text | [period] |

**No names are collected from girls.** Staff see a short anonymous ID (e.g. "Girl A19F").

## 3. Lawful basis and consent
- Lawful basis for processing personal data: [consent / vital interests / other — confirm with counsel]. For sensitive (health) data: [basis under the Act — confirm].
- How consent is obtained and recorded: [first message explains Ubah in simple language and links the privacy notice; continuing = consent? / explicit "YES"? — decide with counsel and ethics board].
- **Children:** the Act sets specific conditions for processing children's data (section 33, including consent of a parent or guardian). The pilot tests **with young women aged 18 and over only**. Any work with under-18s needs legal advice, ethics approval and a separate assessment before it starts. [Record the decision.]
- Withdrawal: STOP (no more messages), DELETE (erase her data), "Wipe my history" in the app.

## 4. Necessity and proportionality
- Data minimisation: no names; numbers only hashed + encrypted; coordinates never stored; voice audio kept only with her consent, encrypted, until resolved and 30 days at most; health workers see only the girls assigned to them and only what each girl agreed to share (urgent messages always); aggregate statistics hide groups under 5.
- Processors: [translation provider, e.g. Google Cloud Translation] receives the text of girls' messages and workers' replies; [speech-to-text provider] receives voice audio. [Record where each processes data, and the data processing agreements.]
- Accuracy: answers only from content approved by a named health-partner reviewer.
- Purpose limitation: data is not used for marketing or shared with third parties beyond the processors listed. [Confirm data-sharing agreements with partners: what aggregate reports they receive.]
- Retention: [decide the periods with your legal adviser]. Ubah applies them automatically once set: `RETENTION_INACTIVE_DAYS` (a girl's whole account after that long without activity) and `RETENTION_MESSAGE_DAYS` (older messages; the account stays), with `RETENTION_MODE=report` first (logs what would be deleted) and then `delete`. Girls with an open case are never touched. Already automatic: voice recordings (resolved, or 30 days), login codes (1 day), ended sessions. Audit and access logs are kept as the accountability record: [decide their period]. Girls can delete everything at any time (DELETE, Wipe my history).

## 5. Data subjects' rights
| Right | How Ubah supports it |
|---|---|
| Information | Privacy notice (`docs/privacy-notice-girls.md`), in her language |
| Access | [Process: a girl asks a Dada; an admin exports her conversation by anonymous ID — define and test] |
| Correction | [Process] |
| Deletion | DELETE command / Wipe my history — removes messages, passes, check-ins and cases |
| Objection / withdrawal | STOP; network opt-outs are honoured |

## 6. Risks and measures

| Risk | Likelihood | Impact | Measures in Ubah | Remaining risk | Owner |
|---|---|---|---|---|---|
| Someone else reads her messages on a shared phone | [ ] | High | No account/name; PIN lock in the app; Quick exit; DELETE; WhatsApp held messages show no content; SMS notice reveals nothing | [ ] | [ ] |
| A danger sign is missed | [ ] | Very high | Fixed safety rules + classifier; checked on every message; urgent cases alert nurses by SMS (retried); re-alert every 15 min until answered; model can't go live if danger recall drops | [ ] | [ ] |
| Wrong or unsafe health information | [ ] | High | Approved content only; named reviewer; AI may only rephrase approved text, never translate; "I don't know" + Dada | [ ] | [ ] |
| Staff misuse (browsing cases, leaking) | [ ] | High | Roles with minimum access; 2FA; audit log of every case view and reply; training; confidentiality agreements | [ ] | [ ] |
| Breach of the server or backups | [ ] | High | Encryption of numbers and 2FA secrets; encrypted backups; key held off-server; HTTPS; security headers; lockout; rate limits | [ ] | [ ] |
| Transfer outside Kenya (hosting, Meta, AI/STT providers) | [ ] | Medium | [Hosting location; contracts; safeguards under ss. 48–50; consider self-hosted AI/STT] | [ ] | [ ] |
| Re-identification from statistics | [ ] | Medium | Counts 1–4 shown as "<5"; percentages need ≥5; clinic scores need ≥5 answers | [ ] | [ ] |
| Clinic retaliation against girls who rated it | [ ] | High | Ratings anonymous and aggregated; shared with clinics only from 5 answers | [ ] | [ ] |

## 7. Consultation
- Girls and young women: [co-design sessions, dates, what changed]
- Health partner(s): [ ]
- Protection partner(s): [ ]
- Ethics committee: [name, approval number, date]
- ODPC: [registration; prior consultation if required]

## 8. Sign-off
| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| Data controller (director) | | | | |
| Data protection officer | | | | |
| Health partner | | | | |
| Protection partner | | | | |
